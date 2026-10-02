"""Goyim Screener — desktop app entry point (Windows .exe).

The window is a local web page (ui/index.html) rendered by Windows' built-in Edge WebView2.
Every method on `Api` can be called from the page as `await window.pywebview.api.<name>(...)`.
"""
import os
import subprocess
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if "--selftest" in sys.argv and not os.environ.get("EMA_ZONE_HOME"):
    import tempfile  # keep the self-test's files out of the app folder

    os.environ["EMA_ZONE_HOME"] = tempfile.mkdtemp()

from engine import telegram_bot as tgbot_mod
from engine import notify, paths, store  # noqa: E402
from engine.scanner import Engine  # noqa: E402
from engine.scheduler import AutoScanner  # noqa: E402
from engine import alerts as alerts_mod  # noqa: E402
from engine.screener import ScreenerBuilder  # noqa: E402

APP_VERSION = "2.4.0"
LOG_LINES = []


def log(msg):
    line = f"{datetime.now():%H:%M:%S}  {msg}"
    LOG_LINES.append(line)
    del LOG_LINES[:-500]
    try:
        paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(paths.DATA_DIR / "app.log", "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now():%Y-%m-%d} {line}\n")
    except Exception:
        pass


def _mask(v):
    v = str(v or "")
    return "" if not v else ("•" * 8 + v[-4:] if len(v) > 6 else "•" * len(v))


class Api:
    def __init__(self):
        copied = paths.ensure_user_files()
        if copied:
            log(f"Set up {len(copied)} default files in {paths.HOME}")
        added = store.sync_default_profiles()
        if added:
            log(f"Added new strategies: {', '.join(added)}")
        self._engine = Engine(log=log)
        self._scan_lock = threading.Lock()
        self._auto = AutoScanner(self._daily_job, log=log)
        self._auto.start()
        self._alerts = alerts_mod.AlertChecker(self._engine, log=log)
        self._screener = ScreenerBuilder(self._engine, log=log)
        self._research_cache = {}
        self._bot = tgbot_mod.TelegramBot(self, log=log)

    def _daily_job(self, send_telegram):
        """After the close: the strategy scan, then (optionally) refresh the screener's data."""
        self._run_scan(send_telegram)
        s = store.settings()
        if s.get("screener_auto", True) and not self._screener.status.get("running"):
            try:
                self._screener.build(float(s.get("screener_min_cap_b", 2)))
            except Exception as e:
                log(f"Screener refresh failed: {e}")

    # ---------- state ----------
    def get_state(self):
        e = self._engine
        secrets = store.secrets()
        providers = []
        enabled_map = e.settings.get("providers_enabled", {})
        active = {p.name: p for p in e.providers}
        for cls in e.registry.provider_classes:
            inst = active.get(cls.name)
            ready, msg = inst.ready() if inst else (False, "Turned off")
            providers.append({
                "name": cls.name, "description": cls.description, "supplies": list(cls.supplies),
                "needs": list(cls.needs), "enabled": enabled_map.get(cls.name, True),
                "ready": ready, "message": msg, "signup_url": cls.signup_url,
                "computed": not cls.key_fields and bool(cls.needs),
                "optional": bool(getattr(cls, "optional", False)),
                "keys": [dict(k.to_dict(), value=(_mask(secrets.get(cls.name, {}).get(k.id)) if k.secret
                                                  else secrets.get(cls.name, {}).get(k.id, "")),
                              is_set=bool(secrets.get(cls.name, {}).get(k.id))) for k in cls.key_fields],
            })
        rules = []
        for r in e.registry.rules:
            missing = e.missing_fields(r.needs)
            rules.append({"id": r.id, "name": r.name, "group": r.group, "description": r.description,
                          "needs": list(r.needs), "missing": missing, "default_enabled": r.default_enabled,
                          "missing_sources": e.sources_label(missing) if missing else "",
                          "params": [p.to_dict() for p in r.params]})
        g = e.registry.graders[0] if e.registry.graders else None
        pl = e.registry.planners[0] if e.registry.planners else None
        tg = secrets.get("telegram", {})
        return {
            "version": APP_VERSION,
            "home": str(paths.HOME),
            "settings": e.settings,
            "telegram": {"bot_token": _mask(tg.get("bot_token")), "chat_id": tg.get("chat_id", ""),
                         "is_set": bool(tg.get("bot_token") and tg.get("chat_id"))},
            "profiles": store.profiles(),
            "watchlist": store.watchlist(),
            "providers": sorted(providers, key=lambda p: (p["optional"], p["computed"])),
            "rules": rules,
            "grader": {"name": g.name, "params": [p.to_dict() for p in g.params]} if g else None,
            "planner": {"name": pl.name, "params": [p.to_dict() for p in pl.params]} if pl else None,
            "plugin_errors": [{"file": f, "error": m} for f, m in e.registry.errors],
            "last_scan": store.load("last_scan.json", None),
            "auto_text": self._auto.next_run_text(),
            "capabilities": self._capabilities(),
            "screens": store.load("screens.json", []),
            "bar_watchlist": store.load("bar_watchlist.json", ["SPY", "QQQ", "DIA", "IWM"]),
        }

    def _capabilities(self):
        """Which features the connected data sources make available (others are greyed out)."""
        e = self._engine
        fields = ["bars", "bars_10y", "history", "valuation_history", "revenue_segments", "forward_pe",
                  "analyst_rating", "analyst_score", "peg_ratio", "next_earnings_date", "sector",
                  "sic_sector", "last_earnings_date", "pe_ratio"]
        caps = {f: e.field_available(f) for f in fields}
        for m in ("quotes", "earnings_calendar", "fundamentals_all", "company_info", "shares_outstanding_all"):
            caps[m] = bool(e.providers_with(m))
        caps["sources"] = {f: e.sources_label([f]) for f in fields + ["earnings_calendar"]}
        caps["sources"]["earnings_calendar"] = "Finnhub or Alpha Vantage"
        caps["sources"]["quotes"] = "Public.com"
        caps["sources"]["fundamentals_all"] = "SEC EDGAR"
        return caps

    # ---------- saving ----------
    def save_settings(self, settings):
        cur = store.settings()
        cur.update(settings or {})
        store.save("settings.json", cur)
        self._engine.reload()
        return {"ok": True}

    def save_provider_keys(self, provider_name, keys):
        s = store.load("secrets.json", {})
        group = s.setdefault(provider_name, {})
        for k, v in (keys or {}).items():
            if v is None or str(v).startswith("•"):
                continue        # unchanged masked value
            group[k] = str(v).strip()
        store.save("secrets.json", s)
        self._engine.reload()
        return {"ok": True}

    def save_telegram(self, bot_token, chat_id):
        return self.save_provider_keys("telegram", {"bot_token": bot_token, "chat_id": chat_id})

    def set_provider_enabled(self, name, enabled):
        s = store.settings()
        s.setdefault("providers_enabled", {})[name] = bool(enabled)
        store.save("settings.json", s)
        self._engine.reload()
        return {"ok": True}

    def save_profiles(self, profiles):
        ids = set()
        for p in profiles:
            if not p.get("id") or p["id"] in ids:
                return {"ok": False, "error": "Each strategy needs a unique id"}
            if int(p.get("fast", 0)) >= int(p.get("slow", 0)):
                return {"ok": False, "error": f"{p.get('name')}: fast MA must be shorter than slow MA"}
            ids.add(p["id"])
        store.save("profiles.json", profiles)
        return {"ok": True}

    def save_watchlist(self, tickers):
        return {"ok": True, "watchlist": store.save_watchlist(tickers)}

    # ---------- scanning ----------
    def _run_scan(self, send_telegram, tickers=None):
        if not self._scan_lock.acquire(blocking=False):
            return {"ok": False, "error": "A scan is already running"}
        try:
            self._engine.reload()
            out = self._engine.scan(tickers=tickers, record=tickers is None)
            if send_telegram and self._engine.settings.get("telegram_enabled", True):
                tg = store.secrets().get("telegram", {})
                try:
                    notify.send(tg.get("bot_token"), tg.get("chat_id"), notify.build_message(out))
                    log("Telegram alert sent")
                except Exception as e:
                    log(f"Telegram not sent: {e}")
            return {"ok": True, "scan": out}
        except Exception as e:
            log(f"Scan failed: {e}\n{traceback.format_exc(limit=3)}")
            return {"ok": False, "error": str(e)}
        finally:
            self._scan_lock.release()

    def start_scan(self, send_telegram=False):
        if self._engine.status.get("running"):
            return {"ok": False, "error": "A scan is already running"}
        threading.Thread(target=self._run_scan, args=(bool(send_telegram),), daemon=True).start()
        return {"ok": True}

    def stop_scan(self):
        self._engine.stop()
        return {"ok": True}

    def scan_status(self):
        st = dict(self._engine.status)
        st["app_log"] = LOG_LINES[-60:]
        return st

    def check_ticker(self, ticker):
        t = str(ticker or "").strip().upper()
        if not t:
            return {"ok": False, "error": "Enter a ticker"}
        if self._engine.status.get("running"):
            return {"ok": False, "error": "Wait for the current scan to finish"}
        res = self._run_scan(False, tickers=[t])
        return res

    def get_detail(self, ticker, profile_id):
        try:
            return {"ok": True, **self._engine.detail(ticker, profile_id)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def test_telegram(self):
        tg = store.secrets().get("telegram", {})
        try:
            notify.send(tg.get("bot_token"), tg.get("chat_id"), "✅ Goyim Screener is connected.")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def test_provider(self, name, ticker="AAPL"):
        """Fetch one ticker from one source, part by part, so you can see what your plan includes."""
        from engine.scanner import Context
        prov = next((p for p in self._engine.providers if p.name == name), None)
        if not prov:
            return {"ok": False, "error": "This source is off or didn't load"}
        prof = (store.profiles() or [{"id": "test", "fast": 150, "slow": 200}])[0]
        groups = list(prov.groups) or ["all"]
        works, fails, fields = [], [], []
        for g in groups:
            ctx = Context(self._engine, ticker, prof, {"values": {}, "fetched": set()})
            ctx.requested_group = g
            try:
                data = prov.fetch(ctx) or {}
                got = [k for k, v in data.items() if v is not None]
                (works if got else fails).append(g if got else f"{g} (no data for {ticker})")
                fields += got
            except Exception as e:
                fails.append(f"{g}: {e}")
        ok = bool(works)
        msg = (f"{name}: works for {', '.join(works)}" if ok else f"{name}: nothing worked")
        if fails:
            msg += ". Not available: " + "; ".join(fails)
        return {"ok": ok, "fields": fields, "message": msg, "error": None if ok else msg}

    # ---------- charts ----------
    def get_chart(self, ticker):
        from engine.scanner import Context
        t = str(ticker or "").strip().upper()
        if not t:
            return {"ok": False, "error": "Enter a ticker"}
        e = self._engine
        if not e.field_available("bars_10y"):
            return {"ok": False, "error": "Charts need a price source. Add your Public.com key on Data sources."}
        ctx = Context(e, t, {"id": "chart", "fast": 150, "slow": 200}, e.shared_cache(t))
        try:
            df = ctx.get("bars_10y")
        except Exception as ex:
            try:                                  # 10 years failed: show the 5-year daily chart instead
                df = ctx.get("bars")
            except Exception:
                return {"ok": False, "error": str(ex)}
        if df is None or not len(df):
            return {"ok": False, "error": f"No price data for {t}"}
        r = lambda col: [round(float(x), 4) for x in df[col]]
        quote = None
        try:
            quote = e.call_first("quotes", [t])[0].get(t)
        except Exception:
            pass
        return {"ok": True, "ticker": t, "t": [d.strftime("%Y-%m-%d") for d in df.index],
                "o": r("open"), "h": r("high"), "l": r("low"), "c": r("close"),
                "v": [int(x) for x in df["volume"]], "quote": quote,
                "weekly_until": df.attrs.get("weekly_until"), "older_bars": df.attrs.get("older_bars")}

    def save_chart_settings(self, cfg):
        s = store.settings()
        s["chart"] = cfg
        store.save("settings.json", s)
        return {"ok": True}

    # ---------- research / compare ----------
    def get_research(self, ticker, with_segments=True):
        from engine.scanner import Context
        t = str(ticker or "").strip().upper()
        if not t:
            return {"ok": False, "error": "Enter a ticker"}
        key = (t, datetime.now().date().isoformat(), bool(with_segments))
        if key in self._research_cache:
            return self._research_cache[key]
        e = self._engine
        ctx = Context(e, t, {"id": "research", "fast": 150, "slow": 200}, e.shared_cache(t))
        out = {"ok": True, "ticker": t, "errors": {}, "unavailable": {}}

        def grab(field, label):
            if not e.field_available(field):
                out["unavailable"][label] = e.sources_label(e.missing_fields([field]) or [field])
                return None
            try:
                return ctx.get(field)
            except Exception as ex:
                out["errors"][label] = str(ex)
                return None

        out["history"] = grab("history", "fundamentals")
        if not out["history"] and "fundamentals" not in out["unavailable"] and "fundamentals" not in out["errors"]:
            out["errors"]["fundamentals"] = f"No quarterly filings found for {t}"
        out["valuation"] = grab("valuation_history", "valuation")
        if with_segments:
            out["segments"] = grab("revenue_segments", "segments")
        out["sector"] = grab("sic_sector", "sector") if e.field_available("sic_sector") else None
        try:
            out["quote"] = e.call_first("quotes", [t])[0].get(t)
        except Exception:
            out["quote"] = None
        out["stats"] = self._research_stats(t, ctx, out)
        if out["history"] or out["valuation"]:
            self._research_cache[key] = out
        return out

    def _research_stats(self, t, ctx, r):
        """Company header + Statistics (TTM). Optional-source fields are filled only when connected."""
        from engine import stats as stats_mod
        e = self._engine
        extra = {}
        try:
            info, _ = e.call_first("company_info", t)
            extra.update({k: info.get(k) for k in ("name", "website", "exchange", "last_earnings_date")})
            extra["industry"] = info.get("sic_description")
            extra["sector"] = info.get("sic_sector")
        except Exception:
            pass
        for f in ("sector", "industry", "forward_pe", "next_earnings_date", "peg_ratio", "high_52w", "low_52w"):
            if not e.field_available(f) or (f in ("sector", "industry") and e.provider_for(f) is None):
                continue
            prov = e.provider_for(f)
            if f in ("sector", "industry") and prov is not None and prov.name == "SEC EDGAR":
                continue
            try:
                v = ctx.get(f)
                if v not in (None, ""):
                    extra[f] = v
            except Exception:
                pass
        bars = None
        if e.field_available("bars_10y"):
            try:
                bars = ctx.get("bars_10y")
            except Exception:
                bars = None
        try:
            return stats_mod.build(r, bars, extra)
        except Exception as ex:
            r.setdefault("errors", {})["statistics"] = str(ex)
            return None

    # ---------- backtest ----------
    def run_backtest(self, ticker, params=None):
        """Every 150/200 EMA pullback in the last ~5 years of daily prices and what happened next."""
        from engine import backtest as bt
        from engine.scanner import Context
        t = str(ticker or "").strip().upper()
        if not t:
            return {"ok": False, "error": "Enter a ticker"}
        e = self._engine
        if not e.field_available("bars"):
            return {"ok": False, "error": "Backtests need daily prices. Add your Public.com key on Data sources."}
        p = dict(params or {})
        if not p:                                   # default to the Investing strategy's own settings
            inv = next((x for x in store.profiles() if x.get("id") == "investing"), {})
            rp = (inv.get("rules", {}).get("ma_touch", {}) or {}).get("params", {})
            p = {"fast": inv.get("fast", 150), "slow": inv.get("slow", 200), "kind": inv.get("ma_type", "EMA"),
                 "tolerance": rp.get("tolerance", 0.5), "above_days": rp.get("above_days", 15), "hold": rp.get("hold", True)}
        try:
            bars = Context(e, t, {"id": "backtest", "fast": 150, "slow": 200}, e.shared_cache(t)).get("bars")
            res = bt.run(bars, fast=int(p.get("fast", 150)), slow=int(p.get("slow", 200)), kind=p.get("kind", "EMA"),
                         tolerance=float(p.get("tolerance", 0.5)), above_days=int(p.get("above_days", 15)),
                         hold=bool(p.get("hold", True)), cooldown=int(p.get("cooldown", 10)),
                         mode=p.get("mode", "touch"))
        except Exception as ex:
            return {"ok": False, "error": str(ex)}
        return {"ok": True, "ticker": t, **res}

    def get_compare(self, tickers):
        from engine.scanner import Context
        e = self._engine
        res = []
        for t in [str(x).strip().upper() for x in (tickers or []) if str(x).strip()][:4]:
            r = dict(self.get_research(t, with_segments=False))
            try:
                if e.field_available("bars_10y"):
                    df = Context(e, t, {"id": "chart", "fast": 150, "slow": 200}, e.shared_cache(t)).get("bars_10y")
                    w = df["close"].resample("W-FRI").last().dropna() if df is not None else None
                    r["prices"] = {"t": [d.strftime("%Y-%m-%d") for d in w.index], "c": [round(float(x), 4) for x in w]}
            except Exception as ex:
                r.setdefault("errors", {})["prices"] = str(ex)
            res.append(r)
        return {"ok": True, "items": res}

    # ---------- screener ----------
    def build_screener(self, min_cap_b=None):
        if self._screener.status.get("running"):
            return {"ok": False, "error": "The screener data is already updating"}
        s = store.settings()
        cap = float(min_cap_b or s.get("screener_min_cap_b", 2))
        s["screener_min_cap_b"] = cap
        store.save("settings.json", s)

        def run():
            try:
                self._screener.build(cap)
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True}

    def stop_screener(self):
        self._screener.stop()
        return {"ok": True}

    def screener_status(self):
        return dict(self._screener.status)

    def get_screener_db(self):
        db = store.load("screener_db.json", None)
        if db:
            watch = set(store.watchlist())
            for r in db["rows"]:
                r["in_watchlist"] = r["ticker"] in watch
        return {"ok": True, "db": db}

    def screener_enrich(self, tickers, fields):
        """Fetch fields only optional sources have (forward P/E, analyst rating...) for a short list."""
        from engine.scanner import Context
        e = self._engine
        out, errors = {}, []
        cal = {}
        if "next_earnings_date" in fields and e.providers_with("earnings_calendar"):
            today = datetime.now().date()
            try:
                from datetime import timedelta
                events, _ = e.call_first("earnings_calendar", today.isoformat(),
                                         (today + timedelta(days=90)).isoformat())
                for ev in events:
                    cal.setdefault(ev["symbol"], ev["date"])
            except Exception as ex:
                errors.append(str(ex))
        for t in tickers[:150]:
            row = {}
            for f in fields:
                if f == "next_earnings_date" and cal is not None and e.providers_with("earnings_calendar"):
                    row[f] = cal.get(t)
                    continue
                if not e.field_available(f):
                    continue
                try:
                    row[f] = Context(e, t, {"id": "screener", "fast": 150, "slow": 200}, e.shared_cache(t)).get(f)
                except Exception as ex:
                    errors.append(f"{t}: {ex}")
            out[t] = row
        return {"ok": True, "values": out, "errors": errors[:10]}

    def save_screens(self, screens):
        store.save("screens.json", screens or [])
        return {"ok": True}

    # ---------- calendar ----------
    def get_calendar(self, start, end):
        e = self._engine
        watch = set(store.watchlist()) | set(store.load("bar_watchlist.json", []))
        info = store.load("company_info.json", {})
        past = {t: info[t].get("last_earnings_date") for t in watch if t in info}
        if not e.providers_with("earnings_calendar"):
            return {"ok": True, "available": False, "events": [], "past": past,
                    "needs": "Finnhub or Alpha Vantage"}
        try:
            events, src = e.call_first("earnings_calendar", start, end)
        except Exception as ex:
            return {"ok": False, "available": True, "error": str(ex), "events": [], "past": past}
        caps = {}
        db = store.load("screener_db.json", None)
        if db:
            caps = {r["ticker"]: r.get("market_cap") for r in db["rows"]}
        else:
            for name in ("universe_5B.json", "universe_2B.json", "universe_1B.json"):
                caps.update(store.load(name, {}).get("market_caps", {}))
        for ev in events:
            ev["watch"] = ev["symbol"] in watch
            cap = caps.get(ev["symbol"])
            ev["market_cap"] = cap
            ev["major"] = bool(cap and cap >= 10e9)
        return {"ok": True, "available": True, "source": src, "events": events, "past": past,
                "has_caps": bool(caps)}

    # ---------- alerts ----------
    def list_alerts(self):
        lst = self._alerts.alerts()
        for a in lst:
            a["description"] = alerts_mod.describe(a)
        return {"ok": True, "alerts": lst, "history": self._alerts.history()[:50],
                "market_open": alerts_mod.market_open(), "last_check": self._alerts.last_check,
                "last_error": self._alerts.last_error, "quotes": self._engine.field_available("bars")}

    def save_alert(self, alert):
        try:
            return {"ok": True, "alert": self._alerts.save_alert(alert)}
        except Exception as ex:
            return {"ok": False, "error": str(ex)}

    def delete_alert(self, alert_id):
        self._alerts.delete_alert(alert_id)
        return {"ok": True}

    def check_alerts_now(self):
        try:
            fired = self._alerts.check_now()
            return {"ok": True, "fired": len(fired)}
        except Exception as ex:
            return {"ok": False, "error": str(ex)}

    # ---------- bottom watchlist bar ----------
    def get_bar(self):
        tickers = store.load("bar_watchlist.json", ["SPY", "QQQ", "DIA", "IWM"])
        if not self._engine.field_available("bars"):
            return {"ok": True, "rows": [{"ticker": t} for t in tickers], "needs": "Public.com"}
        try:
            return {"ok": True, "rows": alerts_mod.bar_rows(self._engine, tickers)}
        except Exception as ex:
            return {"ok": False, "error": str(ex), "rows": [{"ticker": t} for t in tickers]}

    def save_bar(self, tickers):
        clean = []
        for t in tickers or []:
            t = str(t).strip().upper()
            if t and t not in clean:
                clean.append(t)
        store.save("bar_watchlist.json", clean)
        return {"ok": True, "tickers": clean}

    # ---------- plugins / files ----------
    def reload_plugins(self):
        self._engine.reload()
        return self.get_state()

    def open_folder(self, which="home"):
        target = {"providers": paths.PROVIDERS_DIR, "rules": paths.RULES_DIR,
                  "data": paths.DATA_DIR}.get(which, paths.HOME)
        target.mkdir(parents=True, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(target)  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
        return {"ok": True}

    def open_url(self, url):
        import webbrowser
        if str(url).startswith("https://"):
            webbrowser.open(url)
        return {"ok": True}


def selftest():
    """Used by the GitHub build to check the packaged app can load its engine and plugins."""
    paths.ensure_user_files()
    eng = Engine(log=lambda m: None)
    import pandas  # noqa: F401  (plugins need these inside the .exe)
    import public_api_sdk  # noqa: F401
    import webview  # noqa: F401
    ok = not eng.registry.errors and len(eng.registry.rules) > 0 and all((paths.UI_DIR / f).exists() for f in ("index.html", "app.js", "pages.js", "icons.js", "style.css"))
    report = Path.cwd() / "selftest.txt"
    report.write_text(f"providers={[p.name for p in eng.providers]}\nrules={len(eng.registry.rules)}\n"
                      f"errors={eng.registry.errors}\nui={paths.UI_DIR}\nok={ok}\n", encoding="utf-8")
    print(report.read_text())
    return 0 if ok else 1


def unblock_downloaded_files():
    """Windows marks files from internet downloads as 'blocked', and the .NET part of the window
    (pythonnet) refuses to load blocked DLLs. Remove that mark from the app's own files."""
    if not (paths.FROZEN and sys.platform.startswith("win")):
        return
    for root, _dirs, files in os.walk(paths.BUNDLE_DIR):
        for name in files:
            if name.lower().endswith((".dll", ".pyd", ".exe")):
                try:
                    os.remove(os.path.join(root, name) + ":Zone.Identifier")
                except OSError:
                    pass


def main():
    if "--selftest" in sys.argv:
        sys.exit(selftest())

    unblock_downloaded_files()
    import webview

    api = Api()
    api._bot.start()          # answers /commands sent to your Telegram bot while the app is open
    theme = store.settings().get("theme", "dark")
    webview.create_window(
        "Goyim Screener", url=str(paths.UI_DIR / "index.html"), js_api=api,
        width=1320, height=860, min_size=(1024, 680),
        background_color="#FFFFFF" if theme == "light" else "#000000",
    )
    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
