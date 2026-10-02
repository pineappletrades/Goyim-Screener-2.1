"""Prices from Public.com's API: daily bars (5 and 10 years) and live quotes."""
import time

from engine.plugin_api import KeyField, Provider


def _bars_to_df(bars):
    import pandas as pd

    if not bars:
        return None
    return pd.DataFrame(
        {"open": [b.open for b in bars], "high": [b.high for b in bars], "low": [b.low for b in bars],
         "close": [b.close for b in bars], "volume": [b.volume for b in bars]},
        index=pd.to_datetime([b.timestamp for b in bars], utc=True),
    ).astype(float).sort_index()


class PublicBars(Provider):
    name = "Public.com"
    description = "Daily price bars (up to 10 years) and live quotes from your Public.com account's API."
    groups = {"bars": ["bars"], "bars_long": ["bars_10y"]}
    supplies = ["bars", "bars_10y"]
    key_fields = [
        KeyField("secret_key", "API secret key", help="public.com → Settings → API → create key"),
        KeyField("account_number", "Account number", secret=False),
    ]
    priority = 10
    signup_url = "https://public.com/settings/v2/api/api-keys"

    _client = None

    def client(self):
        if self._client is None:
            from public_api_sdk import ApiKeyAuthConfig, PublicApiClient, PublicApiClientConfiguration

            self._client = PublicApiClient(
                ApiKeyAuthConfig(api_secret_key=self.keys["secret_key"]),
                config=PublicApiClientConfiguration(default_account_number=self.keys.get("account_number", "")),
            )
        return self._client

    # Only requests Public supports:
    #   daily bars  -> FIVE_YEARS + ONE_DAY (Public's daily limit is 5 years)
    #   10 years    -> TEN_YEARS with no aggregation, so Public picks its own bar size for that period.
    # The 10-year series = Public's long bars for the part older than 5 years + the 5-year daily bars.
    def _get(self, symbol, period, aggregation=None):
        last = None
        for attempt in range(3):
            try:
                kw = {"aggregation": aggregation} if aggregation is not None else {}
                resp = self.client().get_bars(symbol=symbol, period=period, **kw)
                return _bars_to_df(resp.regular_market.bars)
            except Exception as e:
                last = e
                if "400" in str(e) or "not compatible" in str(e):
                    break               # a rejected request won't succeed on retry
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"Public.com bars failed: {last}")

    def _bars(self, symbol, long=False):
        from public_api_sdk import BarAggregation, BarPeriod

        ok, msg = self.ready()
        if not ok:
            raise RuntimeError(f"Public.com: {msg}")
        daily = self._get(symbol, BarPeriod.FIVE_YEARS, BarAggregation.ONE_DAY)
        if not long:
            return daily
        try:
            longer = self._get(symbol, BarPeriod.TEN_YEARS)          # Public chooses the bar size
        except RuntimeError:
            longer = None
        if daily is None or not len(daily):
            return longer
        if longer is None or not len(longer):
            return daily
        import pandas as pd

        older = longer[longer.index < daily.index[0]]
        out = pd.concat([older, daily]).sort_index()
        if len(older) > 1:
            gap = float(pd.Series(older.index).diff().dt.days.median())
            out.attrs["older_bars"] = "weekly" if gap <= 10 else "monthly" if gap <= 40 else "long"
            out.attrs["weekly_until"] = daily.index[0].strftime("%Y-%m-%d")
        return out

    def fetch(self, ctx):
        if getattr(ctx, "requested_group", "bars") == "bars_long":
            return {"bars_10y": self._bars(ctx.ticker, long=True)}
        return {"bars": self._bars(ctx.ticker)}

    def quotes(self, symbols, batch=100):
        """{symbol: {"last": float, "prev_close": float}} for many symbols in few requests."""
        from public_api_sdk import InstrumentType, OrderInstrument

        ok, msg = self.ready()
        if not ok:
            raise RuntimeError(f"Public.com: {msg}")
        out, symbols, i = {}, [s.upper() for s in symbols], 0
        while i < len(symbols):
            chunk = symbols[i:i + batch]
            try:
                for q in self.client().get_quotes(
                        [OrderInstrument(symbol=s, type=InstrumentType.EQUITY) for s in chunk]):
                    if q.last is not None:
                        ts = getattr(q, "last_timestamp", None)
                        out[q.instrument.symbol.upper()] = {
                            "last": float(q.last),
                            "prev_close": float(q.previous_close) if q.previous_close is not None else None,
                            "ts": ts.isoformat() if ts is not None else None}
                i += batch
            except Exception as e:
                if batch > 10:          # a big batch or one bad symbol can fail the whole request
                    batch = max(10, batch // 4)
                    continue
                self.log(f"Public quotes failed for {chunk[:3]}…: {e}")
                i += batch
            time.sleep(0.15)
        return out

    def last_prices(self, symbols, batch=100):
        return {s: q["last"] for s, q in self.quotes(symbols, batch).items()}
