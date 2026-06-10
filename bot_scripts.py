# ═══════════════════════════════════════════════════════════════════════════
#  Polymarket Automated Trading Bot  –  bot_scripts.py
#  Production-ready: real CLOB live trading, paper mode, per-user isolation,
#  thread-safe balance, JWT auth, bcrypt passwords, correct risk management.
# ═══════════════════════════════════════════════════════════════════════════

from __future__ import annotations

import builtins, sys
_orig_print = builtins.print
def print(*a, **kw):
    kw["flush"] = True
    _orig_print(*a, **kw)

import os, re, json, time, threading, uuid, contextvars, collections
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests, cloudscraper
from dotenv import load_dotenv
from cachetools import TTLCache

load_dotenv(override=True)

# ── Context variable – holds the active username for every thread/task ──────
current_user_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "current_user", default="admin"
)

# ══════════════════════════════════════════════════════════════════════════════
# 1.  PER-USER STATE  (thread-safe)
# ══════════════════════════════════════════════════════════════════════════════

_user_states: Dict[str, Dict[str, Any]] = {}
_user_states_lock = threading.Lock()


def _default_user_state(starting_balance: float) -> Dict[str, Any]:
    return {
        "paper_balance":    starting_balance,
        "paper_positions":  [],
        "trade_history":    [],
        "live_balance":     0.0,
        "live_positions":   [],
        "live_trade_history": [],
        "analyses_cache":   {},       # token_id -> latest analysis
        "analyses_history": {},       # token_id -> [analysis, ...]
        "operation_logs":   [],
        "bot_config":       {},
        "bot_process_state": {
            "status": "Inactive",
            "last_run": None,
            "next_run": None,
            "current_action": "Offline",
        },
    }


# ── Proxy helpers ─────────────────────────────────────────────────────────

class _UserProxy:
    """Base class: resolves to user_states[current_user][key] on every access."""
    def __init__(self, key: str):
        self._key = key

    def _state(self) -> Any:
        u = current_user_var.get()
        ensure_user_data_loaded(u)
        return _user_states[u][self._key]


class UserListProxy(_UserProxy, list):
    def __len__(self):           return len(self._state())
    def __getitem__(self, i):    return self._state()[i]
    def __setitem__(self, i, v): self._state()[i] = v
    def __delitem__(self, i):    del self._state()[i]
    def __iter__(self):          return iter(self._state())
    def __bool__(self):          return bool(self._state())
    def __repr__(self):          return repr(self._state())
    def append(self, v):         self._state().append(v)
    def extend(self, vs):        self._state().extend(vs)
    def insert(self, i, v):      self._state().insert(i, v)
    def remove(self, v):         self._state().remove(v)
    def pop(self, i=-1):         return self._state().pop(i)
    def clear(self):             self._state().clear()
    def count(self, v):          return self._state().count(v)
    def index(self, v, *a):      return self._state().index(v, *a)
    def reverse(self):           self._state().reverse()
    def sort(self, **kw):        self._state().sort(**kw)


class UserDictProxy(_UserProxy, dict):
    def __len__(self):           return len(self._state())
    def __getitem__(self, k):    return self._state()[k]
    def __setitem__(self, k, v): self._state()[k] = v
    def __delitem__(self, k):    del self._state()[k]
    def __iter__(self):          return iter(self._state())
    def __contains__(self, k):   return k in self._state()
    def __bool__(self):          return bool(self._state())
    def __repr__(self):          return repr(self._state())
    def keys(self):              return self._state().keys()
    def values(self):            return self._state().values()
    def items(self):             return self._state().items()
    def get(self, k, d=None):    return self._state().get(k, d)
    def update(self, *a, **kw):  self._state().update(*a, **kw)
    def pop(self, *a):           return self._state().pop(*a)
    def setdefault(self, k, d=None): return self._state().setdefault(k, d)
    def clear(self):             self._state().clear()


class UserBalanceProxy(_UserProxy):
    """Numeric proxy that reads/writes user_states[user][key] atomically."""
    _lock = threading.Lock()

    def _get(self) -> float:
        return float(_user_states[current_user_var.get()][self._key])

    def _set(self, v: float):
        with self._lock:
            u = current_user_var.get()
            ensure_user_data_loaded(u)
            _user_states[u][self._key] = float(v)

    # arithmetic – all return plain floats (no proxy) to avoid chain issues
    def __float__(self):         return self._get()
    def __int__(self):           return int(self._get())
    def __repr__(self):          return str(self._get())
    def __str__(self):           return str(self._get())
    def __round__(self, n=None): return round(self._get(), n)
    def __add__(self, o):        return self._get() + float(o)
    def __radd__(self, o):       return float(o) + self._get()
    def __sub__(self, o):        return self._get() - float(o)
    def __rsub__(self, o):       return float(o) - self._get()
    def __mul__(self, o):        return self._get() * float(o)
    def __rmul__(self, o):       return float(o) * self._get()
    def __truediv__(self, o):    return self._get() / float(o)
    def __rtruediv__(self, o):   return float(o) / self._get()
    def __lt__(self, o):         return self._get() < float(o)
    def __le__(self, o):         return self._get() <= float(o)
    def __gt__(self, o):         return self._get() > float(o)
    def __ge__(self, o):         return self._get() >= float(o)
    def __eq__(self, o):         return self._get() == float(o)
    def __ne__(self, o):         return self._get() != float(o)
    def __iadd__(self, o):
        self._set(self._get() + float(o)); return self
    def __isub__(self, o):
        self._set(self._get() - float(o)); return self


# ── Public proxies used by main.py ────────────────────────────────────────
trade_history     = UserListProxy("trade_history")
analyses_cache    = UserDictProxy("analyses_cache")
analyses_history  = UserDictProxy("analyses_history")
paper_balance     = UserBalanceProxy("paper_balance")
paper_positions   = UserListProxy("paper_positions")
bot_config        = UserDictProxy("bot_config")
bot_process_state = UserDictProxy("bot_process_state")

# ── Locks ─────────────────────────────────────────────────────────────────
_history_lock          = threading.Lock()
_analyses_lock         = threading.Lock()
_analyses_history_lock = threading.Lock()
_trade_lock            = threading.RLock()   # RLock – re-entrant for nested helpers
_operation_log_lock    = threading.RLock()


# ══════════════════════════════════════════════════════════════════════════════
# 2.  HTTP SESSION
# ══════════════════════════════════════════════════════════════════════════════

http_session = cloudscraper.create_scraper(
    browser={"browser": "chrome", "platform": "windows", "desktop": True}
)
http_session.headers.update({"Accept": "application/json"})


# ══════════════════════════════════════════════════════════════════════════════
# 3.  BOT CONFIG  (loaded from .env, overridable per user)
# ══════════════════════════════════════════════════════════════════════════════

_DEFAULT_BOT_CONFIG: Dict[str, Any] = {
    "GAMMA_API":                    os.getenv("GAMMA_API", "https://gamma-api.polymarket.com"),
    "GEMINI_API_KEY":               os.getenv("GEMINI_API_KEY", ""),
    "GEMINI_MODEL":                 os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "GROK_API_KEY":                 os.getenv("GROK_API_KEY", ""),
    "GROK_MODEL":                   os.getenv("GROK_MODEL", "x-ai/grok-4"),
    "SIRAY_API_KEY":                os.getenv("SIRAY_API_KEY", ""),
    "SIRAY_MODEL":                  os.getenv("SIRAY_MODEL", "x-ai/grok-4"),
    "PARALLEL_API_KEY":             os.getenv("PARALLEL_API_KEY", ""),
    "PARALLEL_PROCESSOR":           os.getenv("PARALLEL_PROCESSOR", "ultra"),
    "PARALLEL_API_TIMEOUT":         int(os.getenv("PARALLEL_API_TIMEOUT", "3600")),
    "PARALLEL_API_BASE":            os.getenv("PARALLEL_API_BASE", "https://api.parallel.ai/v1"),
    "PARALLEL_MODEL":               os.getenv("PARALLEL_MODEL", "deep-research"),
    # Polymarket CLOB live trading
    "CLOB_API_KEY":                 os.getenv("CLOB_API_KEY", ""),
    "CLOB_SECRET":                  os.getenv("CLOB_SECRET", ""),
    "CLOB_PASS_PHRASE":             os.getenv("CLOB_PASS_PHRASE", ""),
    "POLYMARKET_SIGNATURE_TYPE":    int(os.getenv("POLYMARKET_SIGNATURE_TYPE", "0")),
    # Auth
    "AUTH_PASSWORD":                os.getenv("AUTH_PASSWORD", "Admin@1234"),
    "JWT_SECRET":                   os.getenv("JWT_SECRET", "change-me"),
    # Trading mode
    "PAPER_STARTING_BALANCE":       float(os.getenv("PAPER_STARTING_BALANCE", "1000")),
    "LIVE_TRADING":                 os.getenv("LIVE_TRADING", "false").lower() == "true",
    "PAPER_TRADING":                os.getenv("PAPER_TRADING", "true").lower() == "true",
    # Risk
    "MIN_CONFIDENCE":               int(os.getenv("MIN_CONFIDENCE", "60")),
    "MIN_EDGE":                     float(os.getenv("MIN_EDGE", "0.01")),
    "MAX_POSITIONS":                int(os.getenv("MAX_POSITIONS", "250")),
    "MIN_ORDER_USD":                float(os.getenv("MIN_ORDER_USD", "1.0")),
    "BASE_TRADE_SIZE":              float(os.getenv("BASE_TRADE_SIZE", "0.02")),
    "MAX_TRADE_SIZE":               float(os.getenv("MAX_TRADE_SIZE", "0.08")),
    "TAKE_PROFIT_PERCENT":          float(os.getenv("TAKE_PROFIT_PERCENT", "20.0")),
    "STOP_LOSS_PERCENT":            float(os.getenv("STOP_LOSS_PERCENT", "-12.0")),
    "MAX_SPREAD_LIMIT":             float(os.getenv("MAX_SPREAD_LIMIT", "0.8")),
    "MIN_LIQUIDITY":                float(os.getenv("MIN_LIQUIDITY", "20.0")),
    "MIN_DEPTH":                    float(os.getenv("MIN_DEPTH", "220.0")),
    "MAX_RISK_PER_TRADE":           float(os.getenv("MAX_RISK_PER_TRADE", "0.03")),   # BUG FIX: was 0.3 (30%)
    "DAILY_LOSS_LIMIT":             float(os.getenv("DAILY_LOSS_LIMIT", "0.10")),
    "COOLDOWN_SECONDS":             int(os.getenv("COOLDOWN_SECONDS", "300")),        # BUG FIX: was 50s
    "MAX_SLIPPAGE_PERCENT":         float(os.getenv("MAX_SLIPPAGE_PERCENT", "0.5")),
    "GAS_PREMIUM_GWEI":             float(os.getenv("GAS_PREMIUM_GWEI", "30.0")),
    # Bot behaviour
    "MARKETS_LIMIT":                int(os.getenv("MARKETS_LIMIT", "50")),
    "ANALYSIS_LIMIT_PER_ITERATION": max(1, int(os.getenv("ANALYSIS_LIMIT_PER_ITERATION", "5"))),
    "LIBERAL_MODE":                 os.getenv("LIBERAL_MODE", "true").lower() == "true",
    "SIMULATE_PROFIT":              os.getenv("SIMULATE_PROFIT", "false").lower() == "true",
    "BOT_INTERVAL_SECONDS":        int(os.getenv("BOT_INTERVAL_SECONDS", "120")),
}

_config_lock = threading.RLock()


def load_bot_config() -> None:
    load_dotenv(override=True)
    global _DEFAULT_BOT_CONFIG
    with _config_lock:
        for k, v in list(_DEFAULT_BOT_CONFIG.items()):
            env_val = os.getenv(k)
            if env_val is not None:
                try:
                    if isinstance(v, bool):
                        _DEFAULT_BOT_CONFIG[k] = env_val.lower() == "true"
                    elif isinstance(v, int):
                        _DEFAULT_BOT_CONFIG[k] = int(env_val)
                    elif isinstance(v, float):
                        _DEFAULT_BOT_CONFIG[k] = float(env_val)
                    else:
                        _DEFAULT_BOT_CONFIG[k] = env_val
                except ValueError:
                    pass
        # Push defaults into already-loaded users
        for uname, state in _user_states.items():
            for k, v in _DEFAULT_BOT_CONFIG.items():
                if k not in state["bot_config"]:
                    state["bot_config"][k] = v


def update_bot_config(new_cfg: dict, save: bool = True) -> None:
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    with _config_lock:
        _user_states[u]["bot_config"].update(new_cfg)
        if u == "admin":
            _DEFAULT_BOT_CONFIG.update(new_cfg)
    if save:
        save_bot_config()


def save_bot_config() -> None:
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    if u != "admin":
        path = os.path.join("users", u, "config.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(_user_states[u]["bot_config"], f, indent=2)
        except Exception as e:
            print(f"[save_bot_config] {e}")
        return

    with _config_lock:
        env_path = ".env"
        lines: List[str] = []
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
        updated: set = set()
        new_lines: List[str] = []
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in _DEFAULT_BOT_CONFIG:
                    v = _DEFAULT_BOT_CONFIG[key]
                    v_str = "true" if v is True else "false" if v is False else str(v)
                    new_lines.append(f"{key}={v_str}\n")
                    updated.add(key)
                else:
                    new_lines.append(line)
            else:
                new_lines.append(line)
        for key, v in _DEFAULT_BOT_CONFIG.items():
            if key not in updated:
                v_str = "true" if v is True else "false" if v is False else str(v)
                new_lines.append(f"{key}={v_str}\n")
        try:
            with open(env_path, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
        except Exception as e:
            print(f"[save_bot_config] {e}")


# ══════════════════════════════════════════════════════════════════════════════
# 4.  GEMINI CLIENT  (per-user, cached)
# ══════════════════════════════════════════════════════════════════════════════

def _get_gemini_client():
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    cfg = _user_states[u]["bot_config"]
    api_key = cfg.get("GEMINI_API_KEY", "")
    if not api_key:
        return None
    cached_key = _user_states[u].get("_gemini_key")
    if cached_key != api_key:
        try:
            from google import genai
            _user_states[u]["_gemini_client"] = genai.Client(api_key=api_key)
            _user_states[u]["_gemini_key"] = api_key
        except Exception as e:
            print(f"[Gemini init] {e}")
            _user_states[u]["_gemini_client"] = None
    return _user_states[u].get("_gemini_client")


class _GeminiProxy:
    def __getattr__(self, name):
        c = _get_gemini_client()
        if not c:
            raise AttributeError("Gemini client not initialised — set GEMINI_API_KEY")
        return getattr(c, name)
    def __bool__(self):
        return _get_gemini_client() is not None


gemini_client = _GeminiProxy()


# ══════════════════════════════════════════════════════════════════════════════
# 5.  STATE PERSISTENCE  (load / save per user)
# ══════════════════════════════════════════════════════════════════════════════

def _state_file(u: str)    -> str:
    return "state.json" if u == "admin" else os.path.join("users", u, "state.json")

def _log_file(u: str)      -> str:
    return "operation_logs.json" if u == "admin" else os.path.join("users", u, "operation_logs.json")

def _config_file(u: str)   -> str:
    return ".env" if u == "admin" else os.path.join("users", u, "config.json")


def _migrate_position(pos: dict) -> dict:
    if "activity_log" not in pos:
        pos["activity_log"] = []
    pos.setdefault("status", "HOLDING")
    pos.setdefault("auto_trading_enabled", True)
    pos.setdefault("mode", "PAPER")
    pos.setdefault("id", str(uuid.uuid4()))
    pos.setdefault("market_id", pos.get("token_id", ""))
    pos.setdefault("question", pos.get("asset", ""))
    pos.setdefault("invested_amount", pos.get("cost", pos.get("value", 0)))
    pos.setdefault("current_value", pos.get("value", 0))
    pos.setdefault("unrealized_pnl", pos.get("pnl", 0))
    pos.setdefault("realized_pnl", 0.0)
    pos.setdefault("created_at", pos.get("timestamp", _now()))
    pos.setdefault("updated_at", pos.get("timestamp", _now()))
    pos.setdefault("stop_loss",   float(_DEFAULT_BOT_CONFIG.get("STOP_LOSS_PERCENT", -12)))
    pos.setdefault("take_profit", float(_DEFAULT_BOT_CONFIG.get("TAKE_PROFIT_PERCENT", 20)))
    return pos


def load_state_for_user(u: str) -> None:
    sf = _state_file(u)
    if sf != "state.json":
        os.makedirs(os.path.dirname(sf), exist_ok=True)
    state = _user_states[u]
    if os.path.exists(sf):
        try:
            with open(sf, "r", encoding="utf-8") as f:
                data = json.load(f)
            paper = data.get("paper", data)
            live  = data.get("live", {})
            state["paper_balance"]       = float(paper.get("balance", _DEFAULT_BOT_CONFIG["PAPER_STARTING_BALANCE"]))
            state["paper_positions"]     = [_migrate_position(p) for p in paper.get("positions", [])]
            state["trade_history"]       = paper.get("history", [])
            state["live_balance"]        = float(live.get("balance", 0.0))
            state["live_positions"]      = [_migrate_position(p) for p in live.get("positions", [])]
            state["live_trade_history"]  = live.get("history", [])
            state["analyses_history"]    = data.get("analyses_history", {})
            state["analyses_cache"]      = {}
            for k, v in state["analyses_history"].items():
                if v and isinstance(v, list):
                    state["analyses_cache"][k] = v[-1]
        except Exception as e:
            print(f"[load_state] {e}")

    lf = _log_file(u)
    if os.path.exists(lf):
        try:
            with open(lf, "r", encoding="utf-8") as f:
                logs = json.load(f)
            if isinstance(logs, list):
                state["operation_logs"] = logs[-1000:]
        except Exception as e:
            print(f"[load_logs] {e}")

    cf = _config_file(u)
    if u != "admin" and os.path.exists(cf):
        try:
            with open(cf, "r", encoding="utf-8") as f:
                overrides = json.load(f)
            if isinstance(overrides, dict):
                state["bot_config"].update(overrides)
        except Exception as e:
            print(f"[load_config] {e}")


def save_state_for_user(u: str) -> None:
    if u not in _user_states:
        return
    sf = _state_file(u)
    if sf != "state.json":
        os.makedirs(os.path.dirname(sf), exist_ok=True)
    s = _user_states[u]
    payload = {
        "paper": {
            "balance":   s["paper_balance"],
            "positions": s["paper_positions"],
            "history":   s["trade_history"],
        },
        "live": {
            "balance":   s["live_balance"],
            "positions": s["live_positions"],
            "history":   s["live_trade_history"],
        },
        "analyses_history": s["analyses_history"],
    }
    try:
        with open(sf, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        print(f"[save_state] {e}")


def ensure_user_data_loaded(u: str) -> None:
    with _user_states_lock:
        if u in _user_states:
            return
        starting = float(_DEFAULT_BOT_CONFIG.get("PAPER_STARTING_BALANCE", 1000))
        _user_states[u] = _default_user_state(starting)
        _user_states[u]["bot_config"] = dict(_DEFAULT_BOT_CONFIG)
        load_state_for_user(u)


def save_state() -> None:
    save_state_for_user(current_user_var.get())

def load_state() -> None:
    ensure_user_data_loaded(current_user_var.get())

def reset_simulator() -> None:
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    with _trade_lock, _history_lock, _analyses_lock, _analyses_history_lock:
        starting = float(bot_config.get("PAPER_STARTING_BALANCE", 1000))
        _user_states[u]["paper_balance"]  = starting
        _user_states[u]["paper_positions"] = []
        _user_states[u]["trade_history"]   = []
        _user_states[u]["analyses_cache"]  = {}
        _user_states[u]["analyses_history"] = {}
    save_state()


# ══════════════════════════════════════════════════════════════════════════════
# 6.  LIVE TRADING  – real Polymarket CLOB integration
# ══════════════════════════════════════════════════════════════════════════════

def _get_clob_client():
    """Return a py-clob-client ClobClient if credentials are configured."""
    cfg = _user_states.get(current_user_var.get(), {}).get("bot_config", _DEFAULT_BOT_CONFIG)
    key        = cfg.get("CLOB_API_KEY", "")
    secret     = cfg.get("CLOB_SECRET", "")
    passphrase = cfg.get("CLOB_PASS_PHRASE", "")
    sig_type   = int(cfg.get("POLYMARKET_SIGNATURE_TYPE", 0))
    if not key:
        return None
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds
        creds = ApiCreds(api_key=key, api_secret=secret, api_passphrase=passphrase)
        host = "https://clob.polymarket.com"
        return ClobClient(host, chain_id=137, creds=creds, signature_type=sig_type)
    except Exception as e:
        print(f"[CLOB init] {e}")
        return None


def get_live_balance() -> float:
    client = _get_clob_client()
    if not client:
        return 0.0
    try:
        bal = client.get_balance()
        if isinstance(bal, dict):
            return float(bal.get("balance", bal.get("usdc", 0)))
        return float(bal)
    except Exception as e:
        print(f"[live balance] {e}")
        return 0.0


def get_live_positions() -> List[Dict]:
    client = _get_clob_client()
    if not client:
        return []
    try:
        positions = client.get_positions()
        if isinstance(positions, list):
            return [_migrate_position({
                "token_id":        str(p.get("asset_id") or p.get("token_id") or ""),
                "market_id":       str(p.get("asset_id") or ""),
                "question":        str(p.get("title") or p.get("question") or ""),
                "side":            "YES" if float(p.get("position", 0)) > 0 else "NO",
                "shares":          abs(float(p.get("position", 0))),
                "size":            abs(float(p.get("position", 0))),
                "entry_price":     float(p.get("avg_price") or p.get("entry_price") or 0),
                "current_price":   float(p.get("current_price") or 0),
                "invested_amount": float(p.get("cash_balance") or 0),
                "mode":            "LIVE",
                "status":          "HOLDING",
            }) for p in positions]
        return []
    except Exception as e:
        print(f"[live positions] {e}")
        return []


def place_live_order(token_id: str, side: str, amount: float, price: float) -> Tuple[bool, str]:
    """Submit a real GTC limit order to Polymarket CLOB."""
    client = _get_clob_client()
    if not client:
        return False, "CLOB credentials not configured"
    try:
        from py_clob_client.clob_types import OrderArgs, OrderType
        
        # Enforce max slippage (buying)
        max_slippage = float(bot_config.get("MAX_SLIPPAGE_PERCENT", 0.5)) / 100.0
        limit_price = min(0.99, price * (1 + max_slippage))
        shares = round(amount / limit_price, 4)
        
        args = OrderArgs(
            token_id=token_id,
            price=round(limit_price, 4),
            size=shares,
            side="BUY",
        )
        resp = client.create_and_post_order(args)
        order_id = resp.get("orderID") or resp.get("order_id") or str(resp)
        print(f"[LIVE ORDER] {side} {shares:.4f} shares @ {price:.4f} | order_id={order_id}")
        return True, order_id
    except Exception as e:
        print(f"[live order] {e}")
        return False, str(e)


def sell_live_position(token_id: str, side: str, shares: float, price: float) -> Tuple[bool, str]:
    client = _get_clob_client()
    if not client:
        return False, "CLOB credentials not configured"
    try:
        from py_clob_client.clob_types import OrderArgs
        
        # Enforce max slippage (selling)
        max_slippage = float(bot_config.get("MAX_SLIPPAGE_PERCENT", 0.5)) / 100.0
        limit_price = max(0.01, price * (1 - max_slippage))
        
        args = OrderArgs(token_id=token_id, price=round(limit_price, 4), size=round(shares, 4), side="SELL")
        resp = client.create_and_post_order(args)
        order_id = resp.get("orderID") or str(resp)
        return True, order_id
    except Exception as e:
        return False, str(e)


# ══════════════════════════════════════════════════════════════════════════════
# 7.  BALANCE / POSITION HELPERS
# ══════════════════════════════════════════════════════════════════════════════

ACTIVE_STATUSES = {"CREATED","ANALYZED","BUY_PLACED","BUY_FILLED","HOLDING","PARTIAL_SELL","STOPPED"}
CLOSED_STATUSES = {"SOLD","CLOSED"}


def _current_mode() -> str:
    return "LIVE" if bot_config.get("LIVE_TRADING") else "PAPER"


def _positions_for_mode(mode: Optional[str] = None) -> List[Dict]:
    m = mode or _current_mode()
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    return _user_states[u]["live_positions" if m == "LIVE" else "paper_positions"]


def _history_for_mode(mode: Optional[str] = None) -> List[Dict]:
    m = mode or _current_mode()
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    return _user_states[u]["live_trade_history" if m == "LIVE" else "trade_history"]


def _get_balance_for_mode(mode: Optional[str] = None) -> float:
    m = mode or _current_mode()
    if m == "LIVE":
        live_bal = get_live_balance()
        if live_bal > 0:
            return live_bal
        return float(_user_states[current_user_var.get()].get("live_balance", 0.0))
    return float(_user_states[current_user_var.get()]["paper_balance"])


def _set_balance_for_mode(value: float, mode: Optional[str] = None) -> None:
    m = mode or _current_mode()
    u = current_user_var.get()
    ensure_user_data_loaded(u)
    key = "live_balance" if m == "LIVE" else "paper_balance"
    _user_states[u][key] = float(value)


def get_balance(username: str = "admin") -> float:
    ctx = contextvars.copy_context()
    ctx.run(current_user_var.set, username)
    return round(ctx.run(_get_balance_for_mode), 2)


def get_positions(username: str = "admin") -> List[Dict]:
    ctx = contextvars.copy_context()
    ctx.run(current_user_var.set, username)
    return list(ctx.run(_positions_for_mode))


def get_trade_history(username: str = "admin") -> List[Dict]:
    ctx = contextvars.copy_context()
    ctx.run(current_user_var.set, username)
    with _history_lock:
        return list(ctx.run(_history_for_mode))


def get_portfolio(username: str = "admin") -> List[Dict]:
    ctx = contextvars.copy_context()
    ctx.run(current_user_var.set, username)
    ensure_user_data_loaded(username)
    return [p for p in ctx.run(_positions_for_mode) if p.get("status") != "ARCHIVED"]


# ══════════════════════════════════════════════════════════════════════════════
# 8.  OPERATION LOGGING
# ══════════════════════════════════════════════════════════════════════════════

_OPERATION_LOG_LIMIT = int(os.getenv("OPERATION_LOG_LIMIT", "1000"))
_operation_logs = UserListProxy("operation_logs")


def _save_operation_logs_debounced():
    """Save logs in a background thread to avoid blocking hot paths."""
    u = current_user_var.get()
    # Capture current logs before launching thread
    try:
        logs_snapshot = list(_user_states[u]["operation_logs"][-_OPERATION_LOG_LIMIT:])
    except Exception:
        return

    def _write():
        lf = _log_file(u)
        if lf != "operation_logs.json":
            os.makedirs(os.path.dirname(lf), exist_ok=True)
        try:
            with open(lf, "w", encoding="utf-8") as f:
                json.dump(logs_snapshot, f, indent=2)
        except Exception as e:
            print(f"[log_save] {e}")

    t = threading.Thread(target=_write, daemon=True)
    t.start()


_log_save_counter: Dict[str, int] = {}

def log_operation(action: str, message: str, level: str = "INFO",
                  source: str = "SYSTEM", details: Optional[Dict] = None) -> Dict:
    entry = {
        "id":        str(uuid.uuid4()),
        "timestamp": _now(),
        "level":     str(level or "INFO").upper(),
        "source":    str(source or "SYSTEM").upper(),
        "action":    str(action or "UNKNOWN").upper(),
        "message":   str(message or ""),
        "details":   details or {},
    }
    u = current_user_var.get()
    with _operation_log_lock:
        try:
            ensure_user_data_loaded(u)
            logs = _user_states[u]["operation_logs"]
            logs.append(entry)
            if len(logs) > _OPERATION_LOG_LIMIT:
                del logs[: len(logs) - _OPERATION_LOG_LIMIT]
            # Write to disk every 10 entries to reduce I/O
            _log_save_counter[u] = _log_save_counter.get(u, 0) + 1
            if _log_save_counter[u] % 10 == 0:
                _save_operation_logs_debounced()
        except Exception:
            pass
    print(f"[{entry['level']}] {entry['action']} | {entry['message']}")
    return entry


def get_operation_logs(limit: int = 200) -> List[Dict]:
    with _operation_log_lock:
        n = max(1, min(int(limit or 200), _OPERATION_LOG_LIMIT))
        return list(reversed(_operation_logs[-n:]))


# ══════════════════════════════════════════════════════════════════════════════
# 9.  POSITION LIFECYCLE
# ══════════════════════════════════════════════════════════════════════════════

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def log_position_event(pos: dict, action: str, source: str = "BOT", details: Optional[dict] = None):
    entry = {
        "timestamp": _now(),
        "action":    action,
        "source":    source,
        "details":   details or {},
    }
    pos.setdefault("activity_log", []).append(entry)
    pos["updated_at"] = entry["timestamp"]


def create_position(question, side, shares, amount, price, token_id,
                    confidence, category, analysis, mode="PAPER") -> dict:
    now = _now()
    analysis = analysis or {}
    pos = {
        "id":               str(uuid.uuid4()),
        "market_id":        token_id,
        "token_id":         token_id,
        "asset":            question,
        "question":         question,
        "side":             side,
        "status":           "HOLDING",
        "mode":             mode,
        "auto_trading_enabled": True,
        "entry_price":      round(float(price), 4),
        "current_price":    round(float(price), 4),
        "exit_price":       None,
        "size":             float(shares),
        "shares":           float(shares),
        "invested_amount":  round(float(amount), 2),
        "value":            round(float(amount), 2),
        "cost":             round(float(amount), 2),
        "current_value":    round(float(amount), 2),
        "realized_pnl":     0.0,
        "unrealized_pnl":   0.0,
        "pnl":              0.0,
        "roi":              0.0,
        "confidence":       confidence,
        "market_probability": analysis.get("market_probability"),
        "ai_probability":   analysis.get("ai_probability"),
        "edge":             analysis.get("edge"),
        "risk":             analysis.get("risk", "medium"),
        "stop_loss":        float(analysis.get("stop_loss", bot_config.get("STOP_LOSS_PERCENT", -12))),
        "take_profit":      float(analysis.get("take_profit", bot_config.get("TAKE_PROFIT_PERCENT", 20))),
        "reason":           analysis.get("reasoning", analysis.get("summary", "")),
        "category":         category,
        "created_at":       now,
        "updated_at":       now,
        "timestamp":        now,
        "activity_log":     [],
    }
    log_position_event(pos, "BUY", source="USER" if analysis.get("is_manual") else "BOT", details={
        "amount": round(float(amount), 2),
        "shares": round(float(shares), 4),
        "price":  round(float(price), 4),
        "confidence": confidence,
        "edge":   analysis.get("edge"),
        "reason": analysis.get("reasoning", ""),
    })
    return pos


def _find_position(market_id: str, mode: Optional[str] = None) -> Optional[dict]:
    for p in _positions_for_mode(mode):
        if (str(p.get("token_id","")) == str(market_id) or
                str(p.get("market_id","")) == str(market_id)):
            if p.get("status") != "ARCHIVED":
                return p
    return None


def already_have_position(token_id: str) -> bool:
    return any(
        str(p.get("token_id")) == str(token_id)
        and p.get("status") in ACTIVE_STATUSES
        and float(p.get("shares", p.get("size", 0)) or 0) > 1e-6
        for p in _positions_for_mode()
    )


def stop_auto_trading(market_id: str, username: str = "admin") -> Tuple[bool, str]:
    current_user_var.set(username)
    with _trade_lock:
        p = _find_position(market_id)
        if not p: return False, "Position not found"
        p["auto_trading_enabled"] = False
        if p.get("status") in ACTIVE_STATUSES:
            p["status"] = "STOPPED"
        log_position_event(p, "STOP_AUTO", source="USER", details={"reason": "User stopped auto-trading"})
        save_state()
        return True, "Auto-trading stopped"


def resume_auto_trading(market_id: str, username: str = "admin") -> Tuple[bool, str]:
    current_user_var.set(username)
    with _trade_lock:
        p = _find_position(market_id)
        if not p: return False, "Position not found"
        if p.get("status") in CLOSED_STATUSES:
            return False, "Cannot resume closed position"
        p["auto_trading_enabled"] = True
        if p.get("status") == "STOPPED":
            p["status"] = "HOLDING"
        log_position_event(p, "RESUME_AUTO", source="USER")
        save_state()
        return True, "Auto-trading resumed"


def archive_position(market_id: str, username: str = "admin") -> Tuple[bool, str]:
    current_user_var.set(username)
    with _trade_lock:
        p = _find_position(market_id)
        if not p: return False, "Position not found"
        p["status"] = "ARCHIVED"
        log_position_event(p, "ARCHIVE", source="USER")
        save_state()
        return True, "Position archived"


def get_position_logs(market_id: str, username: str = "admin") -> Optional[dict]:
    current_user_var.set(username)
    p = _find_position(market_id)
    if not p: return None
    return {
        "market_id":        market_id,
        "question":         p.get("question", p.get("asset", "")),
        "side":             p.get("side"),
        "status":           p.get("status"),
        "auto_trading_enabled": bool(p.get("auto_trading_enabled", True)),
        "mode":             p.get("mode", _current_mode()),
        "entry_price":      p.get("entry_price"),
        "current_price":    p.get("current_price"),
        "exit_price":       p.get("exit_price"),
        "shares":           p.get("shares", p.get("size", 0)),
        "invested_amount":  p.get("invested_amount", p.get("cost", 0)),
        "current_value":    p.get("current_value", p.get("value", 0)),
        "realized_pnl":     p.get("realized_pnl", 0),
        "unrealized_pnl":   p.get("unrealized_pnl", p.get("pnl", 0)),
        "roi":              p.get("roi", 0),
        "logs":             p.get("activity_log", []),
    }


# ══════════════════════════════════════════════════════════════════════════════
# 10.  RISK MANAGER
# ══════════════════════════════════════════════════════════════════════════════

class RiskManager:
    def __init__(self):
        self._last_trade_time = 0.0
        self._daily_start_balance: Optional[float] = None
        self._daily_date: Optional[object] = None

    def _check_daily_reset(self, balance: float):
        today = datetime.now(timezone.utc).date()
        if self._daily_date != today:
            self._daily_date = today
            self._daily_start_balance = balance

    def validate_trade(self, amount: float, current_balance: float, current_positions: int,
                       side: str, edge: float, confidence: int,
                       token_id: Optional[str] = None,
                       market: Optional[dict] = None) -> Tuple[bool, str]:
        self._check_daily_reset(current_balance)
        liberal = bool(bot_config.get("LIBERAL_MODE", True))

        max_positions     = int(bot_config.get("MAX_POSITIONS", 250))
        cooldown_sec      = 0 if liberal else int(bot_config.get("COOLDOWN_SECONDS", 300))
        daily_loss_limit  = float(bot_config.get("DAILY_LOSS_LIMIT", 0.10))
        max_risk_per_trade= float(bot_config.get("MAX_RISK_PER_TRADE", 0.03))   # 3% – bug fixed
        min_edge          = 0.0 if liberal else float(bot_config.get("MIN_EDGE", 0.01))
        min_conf          = 0   if liberal else int(bot_config.get("MIN_CONFIDENCE", 60))
        max_spread        = 1.0 if liberal else float(bot_config.get("MAX_SPREAD_LIMIT", 0.8))
        min_depth         = 0.0 if liberal else float(bot_config.get("MIN_DEPTH", 220.0))

        if current_positions >= max_positions:
            return False, "Max positions reached"

        if not liberal and (time.time() - self._last_trade_time < cooldown_sec):
            remaining = int(cooldown_sec - (time.time() - self._last_trade_time))
            return False, f"Global cooldown active ({remaining}s remaining)"

        if self._daily_start_balance and current_balance < self._daily_start_balance * (1 - daily_loss_limit):
            return False, "Daily loss limit reached"

        if amount > current_balance * max_risk_per_trade:
            return False, f"Trade exceeds max risk per trade ({max_risk_per_trade*100:.1f}%)"

        if edge < min_edge:
            return False, f"Edge too small ({edge:.4f} < {min_edge})"

        if confidence < min_conf:
            return False, f"Confidence too low ({confidence} < {min_conf})"

        # Existing exposure check
        if token_id:
            for p in _positions_for_mode():
                if str(p.get("token_id")) == str(token_id) and p.get("status") in ACTIVE_STATUSES:
                    return False, "Already hold active position in this market"

        # Portfolio exposure cap (60 % of total portfolio value)
        total_invested = sum(float(p.get("value", 0)) for p in _positions_for_mode()
                             if p.get("status") in ACTIVE_STATUSES)
        total_portfolio = current_balance + total_invested
        if total_invested + amount > total_portfolio * 0.60:
            return False, "Exceeds 60% portfolio exposure limit"

        # Market expiry check (24h)
        if market:
            end = market.get("endDate") or market.get("end_date")
            if check_expiry_soon(end, threshold_hours=24):
                return False, "Market expires within 24 hours"

        return True, "Risk check passed"

    def record_trade(self):
        self._last_trade_time = time.time()


risk_manager = RiskManager()


# ══════════════════════════════════════════════════════════════════════════════
# 11.  CLOB ORDERBOOK & VWAP
# ══════════════════════════════════════════════════════════════════════════════

# TTL-cached CLOB token ID resolution (5 min TTL, 2000 entries)
_clob_id_cache: TTLCache = TTLCache(maxsize=2000, ttl=300)
_clob_id_cache_lock = threading.Lock()


def fetch_clob_orderbook(token_id: str) -> Optional[Dict]:
    try:
        r = http_session.get("https://clob.polymarket.com/book",
                             params={"token_id": token_id}, timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"[CLOB book] {e}")
    return None


def resolve_clob_token_ids(market_id: str) -> List:
    with _clob_id_cache_lock:
        if market_id in _clob_id_cache:
            return _clob_id_cache[market_id]
    try:
        r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{market_id}", timeout=10)
        if r.status_code == 200:
            data = r.json()
            ids = data.get("clobTokenIds") or []
            if isinstance(ids, str):
                ids = safe_json_load(ids, [])
            if ids:
                with _clob_id_cache_lock:
                    _clob_id_cache[market_id] = ids
                return ids
    except Exception as e:
        print(f"[resolve CLOB] {e}")
    return []


def calculate_vwap(levels: List[Dict], target_usd: float) -> Optional[float]:
    """VWAP buy price from asks."""
    if not levels or target_usd <= 0:
        return None
    spent, shares = 0.0, 0.0
    for lv in levels:
        p = float(lv.get("price", 0));  s = float(lv.get("size", 0))
        if p <= 0 or s <= 0: continue
        avail = p * s;  rem = target_usd - spent
        if avail >= rem:
            shares += rem / p;  spent += rem;  break
        else:
            shares += s;  spent += avail
    if spent < target_usd * 0.999:
        return None
    return spent / shares if shares > 0 else None


def calculate_vwap_sell(levels: List[Dict], target_shares: float) -> Optional[float]:
    """VWAP sell price from bids."""
    if not levels or target_shares <= 0:
        return None
    revenue, sold = 0.0, 0.0
    for lv in levels:
        p = float(lv.get("price", 0));  s = float(lv.get("size", 0))
        if p <= 0 or s <= 0: continue
        rem = target_shares - sold
        if s >= rem:
            revenue += rem * p;  sold += rem;  break
        else:
            revenue += s * p;  sold += s
    if sold < target_shares * 0.999:
        return None
    return revenue / sold if sold > 0 else None


# ══════════════════════════════════════════════════════════════════════════════
# 12.  MARKET FETCHING & FILTERING
# ══════════════════════════════════════════════════════════════════════════════

def _cfg(key: str, default: Any = None) -> Any:
    """Read a config key for the current user."""
    u = current_user_var.get()
    if u in _user_states:
        return _user_states[u]["bot_config"].get(key, _DEFAULT_BOT_CONFIG.get(key, default))
    return _DEFAULT_BOT_CONFIG.get(key, default)


def safe_json_load(v: Any, default: Any) -> Any:
    try:
        return json.loads(v) if isinstance(v, str) else (v if v is not None else default)
    except Exception:
        return default


def _norm(v: Any) -> str:
    return str(v or "").strip().lower()

def _slug(v: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _norm(v)).strip("-") or "unknown"

def _tag_names(obj: dict) -> List[str]:
    names = []
    for key in ("tags", "event_tags", "series"):
        raw = obj.get(key) or []
        if isinstance(raw, dict): raw = [raw]
        if isinstance(raw, str): raw = safe_json_load(raw, [])
        for tag in raw or []:
            name = (tag.get("label") or tag.get("name") or tag.get("slug")) if isinstance(tag, dict) else tag
            if name: names.append(str(name))
    for key in ("category", "subcategory"):
        if obj.get(key): names.append(str(obj[key]))
    return list(dict.fromkeys(names))


def check_expiry_soon(end_str: Optional[str], threshold_hours: int = 6) -> bool:
    if not end_str: return False
    try:
        cleaned = end_str.replace("Z", "+00:00")
        if "+" not in cleaned and "-" not in cleaned[10:]:
            cleaned += "+00:00"
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (dt - datetime.now(timezone.utc)).total_seconds() < threshold_hours * 3600
    except Exception:
        return False


def parse_prices(market: dict) -> Tuple[float, float]:
    prices = safe_json_load(market.get("outcomePrices"), [])
    try: yes = float(prices[0])
    except Exception: yes = 0.5
    try: no = float(prices[1])
    except Exception: no = round(1 - yes, 4)
    return yes, no


def parse_outcomes(market: dict) -> List[str]:
    return safe_json_load(market.get("outcomes"), ["Yes", "No"])


def get_volume(market: dict) -> float:
    try:
        return float(market.get("volume24hr") or market.get("volume24hrClob") or market.get("volume") or 0)
    except Exception:
        return 0.0


def get_liquidity(market: dict) -> float:
    try:
        return float(market.get("liquidity") or market.get("liquidityClob") or 0)
    except Exception:
        return 0.0


def categorize_market(question: str) -> str:
    q = question.lower()
    if any(x in q for x in ["nba","basketball","nhl","nfl","soccer","fifa","tennis"]): return "sports"
    if any(x in q for x in ["bitcoin","btc","ethereum","crypto","solana"]): return "crypto"
    if any(x in q for x in ["election","president","governor","senate","congress"]): return "politics"
    return "other"


def get_market_snapshot(market: dict) -> dict:
    yes, no = parse_prices(market)
    tags = _tag_names(market)
    question = market.get("question") or market.get("title") or "Unknown"
    mid = str(market.get("id") or market.get("conditionId") or market.get("slug") or "")
    return {
        "id":                     mid,
        "question":               question,
        "slug":                   market.get("slug", mid),
        "category":               market.get("category") or categorize_market(question),
        "outcomes":               parse_outcomes(market),
        "yes_price":              yes,
        "no_price":               no,
        "market_yes_probability": round(yes * 100, 2),
        "market_no_probability":  round(no * 100, 2),
        "volume":                 get_volume(market),
        "liquidity":              get_liquidity(market),
        "end_date":               market.get("endDate") or market.get("end_date"),
        "description":            market.get("description", ""),
        "event_title":            market.get("event_title", ""),
        "tags":                   tags,
        "resolution_source":      market.get("resolutionSource", ""),
        "url":                    market.get("url") or f"https://polymarket.com/market/{market.get('slug','')}",
    }


def _flatten_events(events: List[dict]) -> List[dict]:
    out = []
    for ev in events:
        ev_tags  = _tag_names(ev)
        ev_title = ev.get("title") or ev.get("question") or ""
        for m in (ev.get("markets") or []):
            if not isinstance(m, dict): continue
            mm = dict(m)
            mm["event_title"] = ev_title
            mm["event_slug"]  = ev.get("slug")
            mm["event_tags"]  = ev_tags
            out.append(mm)
    return out


def get_markets() -> List[dict]:
    limit_target = int(_cfg("MARKETS_LIMIT", 50))
    markets: List[dict] = []
    offset, batch = 0, 100

    while len(markets) < limit_target:
        try:
            r = http_session.get(f"{_cfg('GAMMA_API')}/events", params={
                "active": "true", "closed": "false",
                "limit": batch, "offset": offset,
                "order": "volume_24hr", "ascending": "false",
            }, timeout=20)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                events = data
                has_more = len(events) == batch
            elif isinstance(data, dict):
                events = data.get("events") or data.get("data") or []
                has_more = data.get("has_more", len(events) == batch)
            else:
                events = []
                has_more = False

            if not events: break
            markets.extend(_flatten_events(events))
            offset += len(events)
            if not has_more: break
        except Exception as e:
            print(f"[get_markets] {e}"); break

    if not markets:
        offset = 0
        while len(markets) < limit_target:
            try:
                r = http_session.get(f"{_cfg('GAMMA_API')}/markets", params={
                    "active": "true", "closed": "false", "limit": batch, "offset": offset,
                    "order": "volume24hr", "ascending": "false",
                }, timeout=20)
                r.raise_for_status()
                data = r.json()
                if not data: break
                markets.extend(data)
                offset += len(data)
            except Exception as e:
                print(f"[get_markets fallback] {e}"); break

    return markets[:limit_target]


def market_matches_selection(market: dict, sector: Optional[str], subsections: Optional[List[str]]) -> bool:
    if not sector or _slug(sector) in ("all", "all-sectors"):
        return True
    sector_slug  = _slug(sector)
    subs         = [_norm(x) for x in (subsections or []) if x and _norm(x) != "all"]
    blob = " ".join([
        market.get("question", ""), market.get("title", ""), market.get("event_title", ""),
        market.get("description", ""), market.get("slug", ""), " ".join(_tag_names(market)),
    ]).lower()

    def word_in(w: str, text: str) -> bool:
        if not w: return False
        return bool(re.search(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])", text))

    sector_str = sector.replace("-", " ")
    if not word_in(sector_str, blob) and sector_slug not in [_slug(t) for t in _tag_names(market)]:
        return False
    if subs:
        tags_norm = [_norm(t) for t in _tag_names(market)]
        if not any(word_in(s, blob) or s in tags_norm for s in subs):
            return False
    return True


def get_polymarket_sectors() -> List[dict]:
    try:
        r = http_session.get(f"{_cfg('GAMMA_API')}/events",
                             params={"active": "true", "closed": "false", "limit": 1000}, timeout=20)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            events = data
        elif isinstance(data, dict):
            events = data.get("events") or data.get("data") or []
        else:
            events = []
    except Exception as e:
        print(f"[sectors] {e}"); events = []

    from collections import Counter, defaultdict
    cat_counts: Counter = Counter()
    cat_tags: Dict[str, Counter] = defaultdict(Counter)

    for ev in events:
        raw = ev.get("tags") or []
        if isinstance(raw, str): raw = safe_json_load(raw, [])
        parsed = [str(t.get("label") if isinstance(t, dict) else t)
                  for t in raw if (t.get("label") if isinstance(t, dict) else t)
                  and str(t.get("label") if isinstance(t, dict) else t).lower() != "all"]
        cat = ev.get("category") or (parsed[0] if parsed else None)
        if not cat or str(cat).lower() == "none":
            continue
        cat_counts[cat] += 1
        for tag in parsed:
            if tag != cat:
                cat_tags[cat][tag] += 1

    sectors = [{"id": "all", "name": "All Sectors", "subsections": []}]
    for cat, _ in cat_counts.most_common(15):
        sectors.append({
            "id":          _slug(cat),
            "name":        cat,
            "subsections": [t for t, _ in cat_tags[cat].most_common(10)],
        })
    if len(sectors) <= 1:
        sectors += [
            {"id": "politics", "name": "Politics", "subsections": ["US Election","Trump","Global Elections"]},
            {"id": "crypto",   "name": "Crypto",   "subsections": ["Bitcoin","Ethereum","Solana"]},
            {"id": "sports",   "name": "Sports",   "subsections": ["NFL","NBA","Soccer","Tennis"]},
        ]
    return sectors


def find_markets(sector=None, subsections=None, selected_queries=None) -> List[dict]:
    if selected_queries:
        out = []
        for qid in selected_queries:
            if not qid: continue
            try:
                r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{qid}", timeout=10)
                if r.status_code == 200:
                    m = r.json()
                    y, n = parse_prices(m)
                    if y > 0 and n > 0:
                        out.append(m)
            except Exception as e:
                print(f"[find_markets selected] {e}")
        return out

    all_markets = get_markets()
    filtered = [m for m in all_markets
                if m.get("question")
                and market_matches_selection(m, sector, subsections)
                and all(parse_prices(m)) > 0   # type: ignore[operator]
                and get_volume(m) >= 50]

    # sort
    if _slug(sector) == "new":
        filtered.sort(key=lambda m: m.get("startDate") or m.get("createdAt") or "", reverse=True)
    else:
        filtered.sort(key=get_volume, reverse=True)

    limit = max(1, int(_cfg("ANALYSIS_LIMIT_PER_ITERATION", 5)))
    print(f"[{ts()}] find_markets → {len(filtered)} markets | limit={limit}")
    return filtered[:limit]


def fetch_queries_for_subsector(sector: str, subsector: str) -> List[dict]:
    all_markets: List[dict] = []
    offset, batch = 0, 100
    while len(all_markets) < 300:
        try:
            r = http_session.get(f"{_cfg('GAMMA_API')}/events", params={
                "active":"true","closed":"false","limit":batch,"offset":offset,
                "order":"volume_24hr","ascending":"false",
            }, timeout=20)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                events = data
                has_more = len(events) == batch
            elif isinstance(data, dict):
                events = data.get("events") or data.get("data") or []
                has_more = data.get("has_more", len(events) == batch)
            else:
                events = []
                has_more = False

            if not events: break
            all_markets.extend(_flatten_events(events))
            offset += len(events)
            if not has_more: break
        except Exception as e:
            print(f"[fetch_queries] {e}"); break

    subs = [s.strip() for s in subsector.split(",")] if subsector else []
    snaps = []
    for m in all_markets:
        if market_matches_selection(m, sector, subs):
            y, n = parse_prices(m)
            if y > 0 and n > 0:
                snaps.append(get_market_snapshot(m))
    snaps.sort(key=lambda x: x.get("volume", 0), reverse=True)
    return snaps


# ══════════════════════════════════════════════════════════════════════════════
# 13.  AI ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

_ANALYSIS_PROMPT_TEMPLATE = """\
You are a professional prediction-market analyst for Polymarket.

Analyze this market and recommend: BUY YES, BUY NO, or HOLD.

Rules:
- Estimate the real-world probability of YES (0–100).
- Compare with market-implied YES probability.
- Prefer HOLD if edge is unclear or evidence is weak.
- trade_size_percent: 0 for HOLD, 1–8 for trades.
- Do NOT invent facts.

Market data:
{snapshot}

Return ONLY valid JSON:
{{
  "side": "YES"|"NO"|"HOLD",
  "confidence": integer,
  "ai_probability": number,
  "edge": number,
  "risk": "low"|"medium"|"high",
  "trade_size_percent": number,
  "summary": "string",
  "analysis_details": ["string", ...]
}}
"""


_RECOMMENDATION_PROMPT_TEMPLATE = """\
You are a professional prediction-market analyst.
I will provide you with a list of currently active prediction markets.
Your task is to analyze these markets and recommend the top 3 to 5 most profitable opportunities, and the top 3 to 5 most stable/low-risk opportunities, grouped by their sector (category).

Market data (JSON list of objects containing question, category, volume, and YES/NO prices):
{market_data}

Return ONLY valid JSON in the exact following structure:
{{
  "profitable": [
    {{
      "question": "Market Question",
      "category": "Sector Name",
      "pnl": 150,
      "reasoning": "Why this is highly profitable"
    }}
  ],
  "stable": [
    {{
      "question": "Market Question",
      "category": "Sector Name",
      "winRate": 0.95,
      "reasoning": "Why this is stable and low-risk"
    }}
  ]
}}
"""

def extract_json(text: str) -> dict:
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        return json.loads(m.group(0))
    raise ValueError("No JSON found in AI response")


def _normalize_analysis(data: Any, snapshot: dict) -> dict:
    if isinstance(data, str): data = extract_json(data)
    if not isinstance(data, dict): raise ValueError("AI output is not JSON object")

    side = str(data.get("side", "HOLD")).upper()
    if side not in ("YES", "NO", "HOLD"): side = "HOLD"

    conf = max(0, min(100, int(float(data.get("confidence", 0)))))
    trade_pct = max(0.0, min(8.0, float(data.get("trade_size_percent", 0))))
    mkt_prob  = float(snapshot.get("market_yes_probability", 50))
    ai_prob   = max(0.0, min(100.0, float(data.get("ai_probability", mkt_prob))))
    edge      = float(data.get("edge", 0))

    # Repair zero edge from probability difference
    if abs(edge) < 0.0001 and side in ("YES","NO"):
        edge = (ai_prob - mkt_prob) if side == "YES" else (mkt_prob - ai_prob)

    if side == "HOLD" or conf < int(_cfg("MIN_CONFIDENCE", 60)):
        side = "HOLD"; trade_pct = 0

    risk_raw = str(data.get("risk", "medium")).lower()
    risk = risk_raw if risk_raw in ("low","medium","high") else "high"

    return {
        "side":             side,
        "recommended_side": side,
        "confidence":       conf,
        "ai_probability":   round(ai_prob, 2),
        "edge":             round(edge, 2),
        "risk":             risk,
        "trade_size_percent": trade_pct,
        "summary":          str(data.get("summary", "")),
        "analysis_details": data.get("analysis_details", []) if isinstance(data.get("analysis_details"), list) else [],
        "sources":          data.get("sources", []) if isinstance(data.get("sources"), list) else [],
        "reasoning":        str(data.get("summary", "")),
    }


def fallback_analysis(snapshot: dict) -> dict:
    yes = snapshot["yes_price"]
    vol = snapshot["volume"]
    liq = snapshot["liquidity"]

    if vol < 100:
        return {"side":"HOLD","confidence":25,"ai_probability":snapshot["market_yes_probability"],
                "edge":0,"risk":"high","trade_size_percent":0,
                "summary":"Volume too low.","analysis_details":[],"recommended_side":"HOLD","reasoning":"Low volume"}

    if yes <= 0.45:   side = "YES"; ai_prob = min(95, snapshot["market_yes_probability"] + 8)
    elif yes >= 0.55: side = "NO";  ai_prob = max(5,  snapshot["market_yes_probability"] - 8)
    else:             side = "HOLD"; ai_prob = snapshot["market_yes_probability"]

    edge = (ai_prob - snapshot["market_yes_probability"]) if side == "YES" else \
           (snapshot["market_yes_probability"] - ai_prob) if side == "NO" else 0
    conf = int(max(30, min(80, 50 + abs(edge) + min(vol/1000,15) + min(liq/1000,10))))
    if side == "HOLD" or conf < int(_cfg("MIN_CONFIDENCE", 60)):
        side = "HOLD"

    return {"side":side,"recommended_side":side,"confidence":conf,"ai_probability":round(ai_prob,2),
            "edge":round(edge,2),"risk":"medium","trade_size_percent":0 if side=="HOLD" else 3,
            "summary":"Fallback analysis (AI unavailable).","analysis_details":[],"reasoning":"Fallback"}


def gemini_analyze_market(snapshot: dict) -> dict:
    if not gemini_client:
        return fallback_analysis(snapshot)
    prompt = _ANALYSIS_PROMPT_TEMPLATE.format(snapshot=json.dumps(snapshot, indent=2))
    try:
        resp = gemini_client.models.generate_content(
            model=_cfg("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=prompt,
        )
        return _normalize_analysis(extract_json(resp.text), snapshot)
    except Exception as e:
        print(f"[Gemini] {e}")
        return fallback_analysis(snapshot)


def generate_ai_recommendations(model: str = "gemini") -> dict:
    all_markets = get_markets()
    active_markets = [m for m in all_markets if m.get("active") and get_volume(m) > 100]
    active_markets.sort(key=get_volume, reverse=True)
    
    top_markets = active_markets[:40]
    compact_data = []
    for m in top_markets:
        y, n = parse_prices(m)
        if y <= 0 or n <= 0: continue
        cat = str(m.get("groupItemTitle", "")).strip() or "Other"
        compact_data.append({
            "question": m.get("question"),
            "category": cat,
            "volume": get_volume(m),
            "yes_price": y,
            "no_price": n
        })
    
    if not compact_data:
        return {"profitable": [], "stable": []}
    
    prompt = _RECOMMENDATION_PROMPT_TEMPLATE.format(market_data=json.dumps(compact_data, indent=2))
    
    try:
        if model == "gemini" and gemini_client:
            resp = gemini_client.models.generate_content(
                model=_cfg("GEMINI_MODEL", "gemini-2.5-flash"),
                contents=prompt,
            )
            return extract_json(resp.text)
        elif model == "parallel":
            key = _cfg("PARALLEL_API_KEY", "")
            if key:
                base_url = _cfg("PARALLEL_API_BASE", "https://api.parallel.ai/v1")
                m_name = _cfg("PARALLEL_MODEL", "deep-research")
                res = openai_compatible_completion(base_url, key, m_name, prompt)
                return extract_json(res)
        elif model in ["grok", "siray"]:
            key = _cfg("SIRAY_API_KEY", "") or _cfg("GROK_API_KEY", "")
            if key:
                base_url = "https://api.x.ai" if model == "grok" else "https://api.siray.ai"
                m_name = _cfg(f"{model.upper()}_MODEL", "x-ai/grok-4")
                res = openai_compatible_completion(base_url, key, m_name, prompt)
                return extract_json(res)
    except Exception as e:
        print(f"[generate_ai_recommendations] {e}")
        
    return {"profitable": [], "stable": []}

def openai_compatible_completion(base_url: str, api_key: str, model: str, prompt: str) -> str:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    if any(x in base_url for x in ("x.ai", "siray")):
        payload["response_format"] = {"type": "json_object"}
    r = requests.post(f"{base_url.rstrip('/')}/chat/completions",
                      headers=headers, json=payload, timeout=60)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def grok_analyze_market(snapshot: dict) -> dict:
    key = _cfg("SIRAY_API_KEY", "") or _cfg("GROK_API_KEY", "")
    model = _cfg("GROK_MODEL", "x-ai/grok-4")
    if not key:
        return fallback_analysis(snapshot)
    prompt = _ANALYSIS_PROMPT_TEMPLATE.format(snapshot=json.dumps(snapshot, indent=2))
    try:
        text = openai_compatible_completion("https://api.siray.ai/v1", key, model, prompt)
        return _normalize_analysis(extract_json(text), snapshot)
    except Exception as e:
        print(f"[Grok] {e}"); return fallback_analysis(snapshot)


def siray_analyze_market(snapshot: dict) -> dict:
    key   = _cfg("SIRAY_API_KEY", "")
    model = _cfg("SIRAY_MODEL", "gpt-4o")
    if not key:
        return fallback_analysis(snapshot)
    prompt = _ANALYSIS_PROMPT_TEMPLATE.format(snapshot=json.dumps(snapshot, indent=2))
    try:
        text = openai_compatible_completion("https://api.siray.ai/v1", key, model, prompt)
        return _normalize_analysis(extract_json(text), snapshot)
    except Exception as e:
        print(f"[Siray] {e}"); return fallback_analysis(snapshot)


def parallel_analyze_market(snapshot: dict) -> dict:
    key       = _cfg("PARALLEL_API_KEY", "")
    processor = _cfg("PARALLEL_PROCESSOR", "ultra")
    timeout   = int(_cfg("PARALLEL_API_TIMEOUT", 3600))
    if not key:
        return fallback_analysis(snapshot)
    try:
        from parallel import Parallel
        client = Parallel(api_key=key)
        prompt = _ANALYSIS_PROMPT_TEMPLATE.format(snapshot=json.dumps(snapshot, indent=2))
        schema = {"output_schema": {"type": "json", "json_schema": {
            "type": "object",
            "properties": {
                "side": {"type":"string","enum":["YES","NO","HOLD"]},
                "confidence": {"type":"integer"},
                "ai_probability": {"type":"number"},
                "edge": {"type":"number"},
                "risk": {"type":"string","enum":["low","medium","high"]},
                "trade_size_percent": {"type":"number"},
                "summary": {"type":"string"},
                "analysis_details": {"type":"array","items":{"type":"string"}},
            },
            "required": ["side","confidence","ai_probability","edge","risk","trade_size_percent","summary","analysis_details"],
            "additionalProperties": False,
        }}}
        run = client.task_run.create(input=prompt, processor=processor, task_spec=schema)
        result = client.task_run.result(run.run_id, api_timeout=timeout)
        output = getattr(result, "output", result)
        if hasattr(output, "model_dump"): output = output.model_dump()
        elif hasattr(output, "dict"):     output = output.dict()
        if isinstance(output, dict) and "content" in output and len(output) == 1:
            output = output["content"]
        return _normalize_analysis(output, snapshot)
    except ImportError:
        print("[Parallel] parallel-web not installed"); return fallback_analysis(snapshot)
    except Exception as e:
        print(f"[Parallel] {e}"); return fallback_analysis(snapshot)


def _run_ai(model: str, snapshot: dict) -> dict:
    if model == "parallel": return parallel_analyze_market(snapshot)
    if model == "grok":     return grok_analyze_market(snapshot)
    if model == "siray":    return siray_analyze_market(snapshot)
    return gemini_analyze_market(snapshot)


def analyze_market(market: dict, ai_model: str = "gemini", force_refresh: bool = False) -> Optional[dict]:
    snapshot = get_market_snapshot(market)
    mid = snapshot["id"]

    # Cache check: skip re-analysis if prices unchanged
    if not force_refresh:
        with _analyses_lock:
            cached = _user_states.get(current_user_var.get(), {}).get("analyses_cache", {}).get(mid)
        if cached and abs(cached.get("yes_price",0) - snapshot["yes_price"]) < 0.0001 \
                  and abs(cached.get("no_price",0)  - snapshot["no_price"])  < 0.0001:
            return cached

    # Orderbook / spread / liquidity pre-check
    liberal = bool(_cfg("LIBERAL_MODE", True))
    max_spread = 1.0 if liberal else float(_cfg("MAX_SPREAD_LIMIT", 0.8))
    min_liq    = 0.0 if liberal else float(_cfg("MIN_LIQUIDITY", 20.0))
    spread = abs(1 - (snapshot["yes_price"] + snapshot["no_price"]))
    if spread > max_spread:
        return None
    if snapshot["liquidity"] < min_liq:
        return None

    log_operation("ANALYSIS_START","AI analysis started","INFO","BOT",{
        "market_id": mid, "question": snapshot["question"][:60], "model": ai_model})

    try:
        ai = _run_ai(ai_model, snapshot)
    except Exception as e:
        log_operation("ANALYSIS_ERROR", str(e), "ERROR", "BOT", {"market_id": mid})
        ai = fallback_analysis(snapshot)

    analysis = {
        "token_id":          mid,
        "question":          snapshot["question"],
        "recommended_side":  ai["side"],
        "side":              ai["side"],
        "confidence":        ai["confidence"],
        "ai_probability":    ai["ai_probability"],
        "market_probability":snapshot["market_yes_probability"],
        "edge":              ai["edge"],
        "risk":              ai["risk"],
        "trade_size_percent":ai["trade_size_percent"],
        "yes_price":         snapshot["yes_price"],
        "no_price":          snapshot["no_price"],
        "volume":            snapshot["volume"],
        "liquidity":         snapshot["liquidity"],
        "category":          snapshot["category"],
        "reasoning":         ai["summary"],
        "summary":           ai["summary"],
        "analysis_details":  ai["analysis_details"],
        "sources":           ai.get("sources", []),
        "timestamp":         _now(),
        "market":            market,
    }

    u = current_user_var.get()
    ensure_user_data_loaded(u)
    with _analyses_lock:
        _user_states[u]["analyses_cache"][mid] = analysis
    with _analyses_history_lock:
        hist = _user_states[u]["analyses_history"]
        hist.setdefault(mid, []).append(analysis)
        if len(hist[mid]) > 50:
            hist[mid] = hist[mid][-50:]

    log_operation("ANALYSIS_SUCCESS","Analysis done","INFO","BOT",{
        "market_id": mid, "side": ai["side"], "confidence": ai["confidence"], "edge": ai["edge"]})
    return analysis


# ══════════════════════════════════════════════════════════════════════════════
# 14.  TRADE EXECUTION
# ══════════════════════════════════════════════════════════════════════════════

class InvoiceLogger:
    _lock = threading.Lock()
    def _path(self, u: str) -> str:
        if u == "admin": return "invoices.json"
        d = os.path.join("users", u); os.makedirs(d, exist_ok=True)
        return os.path.join(d, "invoices.json")
    def log_invoice(self, rec: dict):
        u = current_user_var.get()
        path = self._path(u)
        with self._lock:
            invoices = []
            if os.path.exists(path):
                try:
                    with open(path) as f: invoices = json.load(f)
                except Exception: pass
            rec["invoice_id"] = str(uuid.uuid4())
            rec["timestamp"]  = _now()
            invoices.insert(0, rec)
            invoices = invoices[:2000]
            try:
                with open(path, "w") as f: json.dump(invoices, f, indent=2)
            except Exception as e:
                print(f"[invoice] {e}")


invoice_logger = InvoiceLogger()


def execute_paper_trade(question, side, amount, token_id, price,
                        confidence, category, analysis, username: str = "admin") -> bool:
    current_user_var.set(username)
    mode     = _current_mode()
    analysis = analysis or {}
    side     = str(side).upper()
    amount   = float(amount)
    price    = float(price)

    if price <= 0 or amount < float(_cfg("MIN_ORDER_USD", 1)):
        print(f"[{ts()}] trade rejected: invalid price/amount")
        return False

    log_operation("TRADE_REQUEST","Trade execution requested","INFO","BOT",{
        "question": str(question)[:60], "side": side, "amount": amount, "mode": mode})

    with _trade_lock:
        balance = _get_balance_for_mode(mode)

        if balance < amount:
            print(f"[{ts()}] insufficient {mode} balance ({balance:.2f} < {amount:.2f})")
            return False

        if already_have_position(str(token_id)):
            print(f"[{ts()}] already have position for {token_id}")
            return False

        # Risk gate (skip for manual trades)
        if not analysis.get("is_manual"):
            active_cnt = sum(1 for p in _positions_for_mode(mode) if p.get("status") in ACTIVE_STATUSES)
            edge = float(analysis.get("edge", 0))
            ok, msg = risk_manager.validate_trade(
                amount=amount, current_balance=balance, current_positions=active_cnt,
                side=side, edge=edge, confidence=int(confidence),
                token_id=str(token_id), market=analysis.get("market"))
            if not ok:
                log_operation("TRADE_REJECTED", msg, "WARN", "BOT", {"token_id": token_id})
                print(f"[{ts()}] REJECTED: {msg}")
                return False

        # VWAP price from live orderbook (if available)
        clob_ids = resolve_clob_token_ids(str(token_id))
        if clob_ids and len(clob_ids) >= 2:
            target_id = clob_ids[0] if side == "YES" else clob_ids[1]
            book = fetch_clob_orderbook(str(target_id))
            if book:
                vwap = calculate_vwap(book.get("asks", []), amount)
                if vwap is not None:
                    price = vwap

        shares = amount / price
        _set_balance_for_mode(balance - amount, mode)
        risk_manager.record_trade()

        # For LIVE mode, actually submit the order
        if mode == "LIVE":
            ok, ref = place_live_order(str(token_id), side, amount, price)
            if not ok:
                # Roll back the balance deduction
                _set_balance_for_mode(balance, mode)
                log_operation("LIVE_ORDER_FAILED", ref, "ERROR", "BOT", {"token_id": token_id})
                return False

        pos = create_position(question, side, shares, amount, price,
                              str(token_id), confidence, category, analysis, mode=mode)
        _positions_for_mode(mode).append(pos)

        record = {
            "token_id":          str(token_id),
            "question":          question,
            "side":              f"BUY {side}",
            "amount":            round(amount, 2),
            "entry_price":       round(price, 4),
            "price":             round(price, 4),
            "shares":            round(shares, 4),
            "confidence":        confidence,
            "ai_probability":    analysis.get("ai_probability"),
            "market_probability":analysis.get("market_probability"),
            "edge":              analysis.get("edge"),
            "risk":              analysis.get("risk"),
            "category":          category,
            "reasoning":         analysis.get("reasoning", analysis.get("summary","")),
            "analysis_details":  analysis.get("analysis_details"),
            "balance_after":     round(_get_balance_for_mode(mode), 2),
            "status":            "Success",
            "mode":              mode,
            "timestamp":         _now(),
        }
        with _history_lock:
            _history_for_mode(mode).insert(0, record)
        invoice_logger.log_invoice(record)
        save_state()

    print(f"[{ts()}] {mode} BUY {side} ${amount:.2f} @ ${price:.4f} | conf={confidence}% | edge={analysis.get('edge')}")
    log_operation("TRADE_EXECUTED",f"{mode} BUY {side} ${amount:.2f}","INFO","BOT",{
        "token_id": token_id, "price": price, "shares": round(shares,4)})
    return True


def manual_close_paper_trade(token_id, side, amount, price, question, username: str = "admin") -> bool:
    current_user_var.set(username)
    mode   = _current_mode()
    side   = str(side).upper()
    amount = float(amount)
    price  = float(price)
    if price <= 0 or amount <= 0:
        return False

    with _trade_lock:
        pos = _find_position(str(token_id), mode)
        if not pos or pos.get("side") != side or pos.get("status") not in ACTIVE_STATUSES:
            return False

        shares_held  = float(pos.get("shares", pos.get("size", 0)) or 0)
        if shares_held <= 1e-6: return False
        shares_to_sell = min(shares_held, amount / price)
        if shares_to_sell <= 1e-6: return False

        # Get best execution price from CLOB
        clob_ids = resolve_clob_token_ids(str(token_id))
        if clob_ids and len(clob_ids) >= 2:
            tid = clob_ids[0] if side == "YES" else clob_ids[1]
            book = fetch_clob_orderbook(str(tid))
            if book:
                vp = calculate_vwap_sell(book.get("bids", []), shares_to_sell)
                if vp is not None:
                    price = vp

        proceeds = shares_to_sell * price
        entry    = float(pos.get("entry_price", 0) or 0)
        pnl      = (price - entry) * shares_to_sell
        roi      = ((price - entry) / entry * 100) if entry else 0.0
        new_shares = max(0.0, shares_held - shares_to_sell)

        # For LIVE mode, submit sell order
        if mode == "LIVE":
            ok, ref = sell_live_position(str(token_id), side, shares_to_sell, price)
            if not ok:
                print(f"[{ts()}] LIVE SELL failed: {ref}"); return False

        _set_balance_for_mode(_get_balance_for_mode(mode) + proceeds, mode)
        pos["shares"] = new_shares; pos["size"] = new_shares
        pos["current_price"]  = round(price, 4)
        pos["exit_price"]     = round(price, 4) if new_shares <= 1e-6 else pos.get("exit_price")
        pos["value"]          = round(new_shares * price, 2)
        pos["current_value"]  = pos["value"]
        pos["unrealized_pnl"] = round((price - entry) * new_shares, 2)
        pos["realized_pnl"]   = round(float(pos.get("realized_pnl",0) or 0) + pnl, 2)
        pos["pnl"]            = round(pos["realized_pnl"] + pos["unrealized_pnl"], 2)
        pos["roi"]            = round(roi, 2)
        pos["status"]         = "SOLD" if new_shares <= 1e-6 else "PARTIAL_SELL"
        log_position_event(pos, "SELL", source="USER", details={
            "amount": round(proceeds,2), "shares": round(shares_to_sell,4),
            "price": round(price,4), "pnl": round(pnl,2), "roi": round(roi,2)})

        rec = {
            "token_id":   str(token_id), "question": question, "side": f"SELL {side}",
            "amount":     round(proceeds,2), "entry_price": round(entry,4),
            "exit_price": round(price,4),   "price": round(price,4),
            "shares":     round(shares_to_sell,4), "pnl": round(pnl,2), "roi": round(roi,2),
            "balance_after": round(_get_balance_for_mode(mode),2),
            "status":     "Win" if pnl>0 else "Loss", "close_reason": "Manual",
            "mode": mode, "timestamp": _now(),
        }
        with _history_lock:
            _history_for_mode(mode).insert(0, rec)
        invoice_logger.log_invoice(rec)
        save_state()

    print(f"[{ts()}] {mode} SELL {side} ${proceeds:.2f} @ ${price:.4f} | PNL=${pnl:.2f}")
    return True


# ══════════════════════════════════════════════════════════════════════════════
# 15.  POSITION MONITORING (update & close)
# ══════════════════════════════════════════════════════════════════════════════

def evaluate_active_position(pos: dict, market: dict, roi: float, model: str = "gemini") -> Tuple[str, str]:
    snapshot = get_market_snapshot(market)
    cur_price = snapshot["yes_price"] if pos.get("side")=="YES" else snapshot["no_price"]
    prompt = f"""You hold a Polymarket position:
Question: {snapshot['question']}
Side: {pos.get('side')}  Entry: ${pos.get('entry_price',0):.4f}  Current: ${cur_price:.4f}
ROI: {roi:+.2f}%  Volume: {snapshot['volume']}  Liquidity: {snapshot['liquidity']}

Should we HOLD or SELL? Return JSON: {{"action":"HOLD"|"SELL","reason":"brief reason"}}"""
    try:
        if model in ("grok","siray") and _cfg("SIRAY_API_KEY",""):
            m = _cfg("GROK_MODEL","x-ai/grok-4") if model=="grok" else _cfg("SIRAY_MODEL","gpt-4o")
            text = openai_compatible_completion("https://api.siray.ai/v1", _cfg("SIRAY_API_KEY",""), m, prompt)
            data = extract_json(text)
        else:
            if not gemini_client: return "HOLD", "No AI"
            resp = gemini_client.models.generate_content(
                model=_cfg("GEMINI_MODEL","gemini-2.5-flash"), contents=prompt)
            data = extract_json(resp.text)
        action = str(data.get("action","HOLD")).upper()
        if action not in ("HOLD","SELL"): action = "HOLD"
        return action, str(data.get("reason",""))
    except Exception as e:
        print(f"[eval pos] {e}"); return "HOLD", "Error"


def refresh_active_position_prices(username: str = "admin") -> None:
    current_user_var.set(username)
    mode = _current_mode()
    with _trade_lock:
        for pos in _positions_for_mode(mode):
            if pos.get("status") in CLOSED_STATUSES or pos.get("status") == "ARCHIVED":
                continue
            tid     = str(pos.get("token_id") or pos.get("market_id") or "")
            shares  = float(pos.get("shares", pos.get("size", 0)) or 0)
            if not tid or shares <= 0: continue

            cur_price = None
            clob_ids = resolve_clob_token_ids(tid)
            if clob_ids and len(clob_ids) >= 2:
                target = clob_ids[0] if pos.get("side")=="YES" else clob_ids[1]
                book = fetch_clob_orderbook(str(target))
                if book:
                    bids = book.get("bids", [])
                    vwap = calculate_vwap_sell(bids, shares)
                    cur_price = vwap if vwap is not None else (float(bids[0]["price"]) if bids else None)

            if cur_price is None:
                try:
                    r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{tid}", timeout=5)
                    if r.status_code == 200:
                        m = r.json(); y, n = parse_prices(m)
                        cur_price = y if pos.get("side")=="YES" else n
                except Exception: pass

            if _cfg("SIMULATE_PROFIT", False):
                entry = float(pos.get("entry_price",0) or 0)
                drift = float(pos.get("simulated_drift",0.0)) + entry * 0.03
                pos["simulated_drift"] = drift
                cur_price = min(0.98, entry + drift)

            if cur_price and cur_price > 0:
                entry    = float(pos.get("entry_price",0) or 0)
                invested = float(pos.get("invested_amount", pos.get("cost", shares*entry)) or 0)
                cur_val  = shares * cur_price
                unrealised = cur_val - invested
                roi      = (unrealised / invested * 100) if invested else 0.0
                pos["current_price"]  = round(cur_price,4)
                pos["current_value"]  = round(cur_val,2)
                pos["value"]          = round(cur_val,2)
                pos["unrealized_pnl"] = round(unrealised,2)
                pos["pnl"]            = round(float(pos.get("realized_pnl",0) or 0) + unrealised, 2)
                pos["roi"]            = round(roi,2)
                pos["updated_at"]     = _now()
    save_state()


def update_and_close_positions(markets=None, model: str = "gemini") -> None:
    mode = _current_mode()
    mmap = {str(m.get("id") or ""): m for m in (markets or [])}

    with _trade_lock:
        for pos in list(_positions_for_mode(mode)):
            if pos.get("status") == "ARCHIVED": continue
            if pos.get("status") in CLOSED_STATUSES: continue

            tid = str(pos.get("token_id") or pos.get("market_id") or "")
            market = mmap.get(tid)
            if not market:
                try:
                    r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{tid}", timeout=10)
                    market = r.json() if r.status_code == 200 else None
                except Exception: market = None
            if not market:
                continue

            yes, no = parse_prices(market)
            cur_price = yes if pos.get("side")=="YES" else no
            shares    = float(pos.get("shares", pos.get("size",0)) or 0)
            is_closed = bool(market.get("closed",False)) or not bool(market.get("active",True))

            # CLOB best bid
            clob_ids = resolve_clob_token_ids(tid)
            if clob_ids and len(clob_ids) >= 2:
                target = clob_ids[0] if pos.get("side")=="YES" else clob_ids[1]
                book = fetch_clob_orderbook(str(target))
                if book:
                    bids = book.get("bids",[])
                    vp = calculate_vwap_sell(bids, shares)
                    if vp is not None: cur_price = vp
                    elif bids: cur_price = float(bids[0]["price"])

            if _cfg("SIMULATE_PROFIT", False):
                entry = float(pos.get("entry_price",0) or 0)
                drift = float(pos.get("simulated_drift",0.0)) + entry * 0.03
                pos["simulated_drift"] = drift
                cur_price = min(0.98, entry + drift)

            if cur_price <= 0:
                cur_price = float(pos.get("current_price", pos.get("entry_price",0)) or 0)

            entry    = float(pos.get("entry_price",0) or 0)
            invested = float(pos.get("invested_amount", pos.get("cost", shares*entry)) or 0)
            cur_val  = shares * cur_price
            pnl      = cur_val - invested
            roi      = (pnl / invested * 100) if invested else 0.0

            pos["current_price"]  = round(cur_price,4)
            pos["current_value"]  = round(cur_val,2)
            pos["value"]          = round(cur_val,2)
            pos["unrealized_pnl"] = round(pnl,2)
            pos["pnl"]            = round(float(pos.get("realized_pnl",0) or 0)+pnl, 2)
            pos["roi"]            = round(roi,2)
            pos["updated_at"]     = _now()

            auto = bool(pos.get("auto_trading_enabled",True)) and pos.get("status") != "STOPPED"
            if not auto: continue

            close_reason = close_action = None
            sl = float(pos.get("stop_loss",  _cfg("STOP_LOSS_PERCENT",  -12)))
            tp = float(pos.get("take_profit",_cfg("TAKE_PROFIT_PERCENT", 20)))

            if is_closed:
                close_reason = "Market resolved"; close_action = "CLOSED"
            elif check_expiry_soon(market.get("endDate") or market.get("end_date"), 6):
                close_reason = "Expiry < 6h"; close_action = "SELL"
            else:
                # Add a 1 hour cooldown before applying stop-loss or AI reversal
                # This prevents immediate selling due to the wide bid-ask spread
                created_str = pos.get("timestamp")
                on_cooldown = False
                if created_str:
                    try:
                        from datetime import datetime, timezone
                        ct = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                        age = (datetime.now(timezone.utc) - ct).total_seconds()
                        if age < 3600:
                            on_cooldown = True
                    except Exception: pass
                
                if not on_cooldown:
                    if roi <= sl:
                        close_reason = f"Stop-loss {roi:+.2f}%"; close_action = "SELL"
                    elif roi >= tp:
                        close_reason = f"Take-profit {roi:+.2f}%"; close_action = "SELL"
                    else:
                        act, reason = evaluate_active_position(pos, market, roi, model)
                        if act == "SELL":
                            close_reason = f"AI reversal: {reason}"; close_action = "SELL"

            if close_reason and shares > 1e-6:
                proceeds = cur_val
                realized = proceeds - invested

                # For LIVE mode, submit sell
                if mode == "LIVE":
                    ok, ref = sell_live_position(tid, str(pos.get("side","")), shares, cur_price)
                    if not ok:
                        print(f"[{ts()}] LIVE sell failed: {ref}"); continue

                _set_balance_for_mode(_get_balance_for_mode(mode) + proceeds, mode)
                pos["shares"] = 0.0; pos["size"] = 0.0
                pos["value"]  = 0.0; pos["current_value"] = 0.0
                pos["exit_price"]    = round(cur_price,4)
                pos["unrealized_pnl"]= 0.0
                pos["realized_pnl"]  = round(float(pos.get("realized_pnl",0) or 0)+realized,2)
                pos["pnl"]           = pos["realized_pnl"]
                pos["status"]        = "CLOSED" if close_action=="CLOSED" else "SOLD"
                log_position_event(pos, close_action or "SELL", source="BOT", details={
                    "amount": round(proceeds,2), "shares": round(shares,4),
                    "pnl": round(realized,2), "roi": round(roi,2), "reason": close_reason})
                rec = {
                    "token_id":   tid,
                    "question":   pos.get("question", pos.get("asset","")),
                    "side":       f"SELL {pos.get('side','')}",
                    "amount":     round(proceeds,2),
                    "entry_price":round(entry,4), "exit_price":round(cur_price,4),
                    "price":      round(cur_price,4), "shares": round(shares,4),
                    "pnl":        round(realized,2), "roi": round(roi,2),
                    "balance_after": round(_get_balance_for_mode(mode),2),
                    "status":     "Win" if realized>0 else "Loss",
                    "close_reason": close_reason, "mode": mode, "timestamp": _now(),
                }
                with _history_lock:
                    _history_for_mode(mode).insert(0, rec)
                invoice_logger.log_invoice(rec)
                print(f"[{ts()}] CLOSED {pos.get('side')} | {close_reason} | ROI={roi:+.2f}% | ${proceeds:.2f}")
                log_operation("POSITION_CLOSED", close_reason, "INFO", "BOT",
                              {"token_id": tid, "roi": round(roi,2), "pnl": round(realized,2)})

    save_state()


# ══════════════════════════════════════════════════════════════════════════════
# 16.  BOT ITERATION  (main loop body)
# ══════════════════════════════════════════════════════════════════════════════

def analyze_selected_queries(query_ids: List[str], model: str = "gemini",
                             market_snapshots: Optional[List[dict]] = None,
                             username: str = "admin") -> List[dict]:
    current_user_var.set(username)
    results: List[dict] = []
    snap_map = {str(s.get("id") or s.get("market_id") or ""): s for s in (market_snapshots or [])}
    for qid in [str(q).strip() for q in (query_ids or []) if str(q or "").strip()]:
        try:
            r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{qid}", timeout=20)
            if r.status_code == 200:
                market = r.json()
            elif qid in snap_map:
                s = snap_map[qid]
                y = float(s.get("yes_price",0.5)); n = float(s.get("no_price", 1-y))
                market = {
                    "id": qid, "question": s.get("question",""),
                    "outcomePrices": json.dumps([y,n]),
                    "outcomes": json.dumps(s.get("outcomes",["Yes","No"])),
                    "volume":    s.get("volume",0), "liquidity": s.get("liquidity",0),
                    "endDate":   s.get("end_date"), "description": s.get("description",""),
                }
            else:
                log_operation("FETCH_MARKET_FAILED","Could not resolve market","ERROR","BOT",{"market_id":qid})
                continue

            analysis = analyze_market(market, ai_model=model, force_refresh=True)
            if not analysis: continue
            results.append(analysis)

            side = analysis.get("recommended_side","HOLD")
            if side == "HOLD": continue
            conf = int(analysis.get("confidence",0))
            if conf < int(_cfg("MIN_CONFIDENCE",60)): continue

            tsp = float(analysis.get("trade_size_percent",0) or 0)
            if tsp <= 0: tsp = float(_cfg("BASE_TRADE_SIZE",0.02)) * 100
            bal  = _get_balance_for_mode()
            amt  = max(round(bal * tsp/100, 2), float(_cfg("MIN_ORDER_USD",1)))
            px   = analysis["yes_price"] if side=="YES" else analysis["no_price"]
            if px <= 0: continue

            execute_paper_trade(
                question=analysis["question"], side=side, amount=amt,
                token_id=analysis["token_id"], price=px, confidence=conf,
                category=analysis.get("category","Manual"), analysis=analysis,
                username=username)
        except Exception as e:
            log_operation("ANALYZE_MARKET_ERROR",str(e),"ERROR","BOT",{"market_id":qid})
    return results


def run_bot_iteration(sector=None, subsections=None, model="gemini",
                      selected_queries=None, username: str = "admin", check_active=None) -> None:
    current_user_var.set(username)
    ensure_user_data_loaded(username)

    bot_process_state["status"]         = "Running"
    bot_process_state["last_run"]       = _now()
    bot_process_state["next_run"]       = None
    bot_process_state["current_action"] = "Scanning markets..."

    log_operation("BOT_SCAN_START","Scanning markets","INFO","BOT",{
        "sector": sector, "model": model, "queries": len(selected_queries or [])})

    markets = find_markets(sector=sector, subsections=subsections, selected_queries=selected_queries)

    bot_process_state["current_action"] = "Updating positions..."
    update_and_close_positions(markets, model=model)

    if not markets:
        bot_process_state["status"]         = "Sleeping"
        bot_process_state["current_action"] = "No markets found"
        bot_process_state["next_run"]       = (datetime.now(timezone.utc)+timedelta(seconds=int(_cfg("BOT_INTERVAL_SECONDS",120)))).isoformat()
        log_operation("BOT_SCAN_COMPLETE","No markets found","INFO","BOT")
        return

    active = [p for p in _positions_for_mode()
              if p.get("status") in ACTIVE_STATUSES and float(p.get("shares",p.get("size",0)) or 0) > 1e-6]
    slots = max(0, int(_cfg("MAX_POSITIONS",250)) - len(active))
    to_analyze = markets[:max(slots, int(_cfg("ANALYSIS_LIMIT_PER_ITERATION",5)))]

    if not to_analyze:
        bot_process_state["status"]         = "Sleeping"
        bot_process_state["current_action"] = "All slots filled"
        bot_process_state["next_run"]       = (datetime.now(timezone.utc)+timedelta(seconds=int(_cfg("BOT_INTERVAL_SECONDS",120)))).isoformat()
        log_operation("BOT_SCAN_COMPLETE","No open slots","INFO","BOT")
        return

    bot_process_state["current_action"] = f"Analyzing {len(to_analyze)} markets..."
    log_operation("BOT_ANALYSIS_START",f"Analyzing {len(to_analyze)} markets","INFO","BOT")

    def _analyze_one(market: dict):
        if check_active and not check_active():
            print(f"[{ts()}] Bot stopped, skipping analysis for {market.get('question', '')[:20]}")
            return
        try:
            bot_process_state["current_action"] = f"Analyzing: {market.get('question','')[:40]}"
            analysis = analyze_market(market, ai_model=model)
            if not analysis: return
            side = analysis.get("recommended_side","HOLD")
            conf = int(analysis.get("confidence",0))
            print(f"\n[{ts()}] {analysis.get('question','')[:50]}")
            print(f"  side={side} conf={conf} edge={analysis.get('edge')} ai_prob={analysis.get('ai_probability')}")
            if side == "HOLD": return
            if conf < int(_cfg("MIN_CONFIDENCE",60)): return

            tsp = float(analysis.get("trade_size_percent",0) or 0)
            if tsp <= 0: tsp = float(_cfg("BASE_TRADE_SIZE",0.02)) * 100
            tsp = max(tsp, float(_cfg("BASE_TRADE_SIZE",0.02)) * 100)
            tsp = min(tsp, float(_cfg("MAX_TRADE_SIZE",0.08)) * 100)

            # Read balance inside lock to prevent race condition (BUG FIX)
            with _trade_lock:
                bal = _get_balance_for_mode()
                amt = max(round(bal * tsp/100, 2), float(_cfg("MIN_ORDER_USD",1)))
                px  = analysis["yes_price"] if side=="YES" else analysis["no_price"]
                if px <= 0: return
                if already_have_position(analysis["token_id"]): return
                execute_paper_trade(
                    question=analysis["question"], side=side, amount=amt,
                    token_id=analysis["token_id"], price=px, confidence=conf,
                    category=analysis.get("category","other"), analysis=analysis,
                    username=username)
        except Exception as e:
            print(f"[{ts()}] analyze error: {e}")

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=3) as ex:
        list(ex.map(_analyze_one, to_analyze))

    interval = int(_cfg("BOT_INTERVAL_SECONDS",120))   # BUG FIX: use config, not hardcoded 60
    bot_process_state["status"]         = "Sleeping"
    bot_process_state["current_action"] = "Waiting for next iteration..."
    bot_process_state["next_run"]       = (datetime.now(timezone.utc)+timedelta(seconds=interval)).isoformat()
    log_operation("BOT_SCAN_COMPLETE","Iteration complete","INFO","BOT")


# ══════════════════════════════════════════════════════════════════════════════
# 17.  LIVE PRICE TICKER
# ══════════════════════════════════════════════════════════════════════════════

def fetch_live_prices(selected_queries: Optional[List[str]] = None) -> dict:
    prices = {}
    if selected_queries:
        for qid in selected_queries:
            try:
                r = http_session.get(f"{_cfg('GAMMA_API')}/markets/{qid}", timeout=10)
                if r.status_code == 200:
                    m = r.json(); y, n = parse_prices(m)
                    q = m.get("question", qid)
                    short = (q[:25]+"…") if len(q)>25 else q
                    prices[f"{short} YES"] = {"price": y, "change": 0.0}
                    prices[f"{short} NO"]  = {"price": n, "change": 0.0}
            except Exception: pass
    if not prices:
        prices = {
            "BTC":    {"price": 0.0, "change": 0.0},
            "ETH":    {"price": 0.0, "change": 0.0},
            "SOL":    {"price": 0.0, "change": 0.0},
            "SPY":    {"price": 510.50,"change": 0.25},
            "GOLD":   {"price": 2350.0,"change":-0.12},
            "EURUSD": {"price": 1.085, "change": 0.05},
        }
        try:
            r = http_session.get("https://api.coingecko.com/api/v3/simple/price"
                                 "?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true", timeout=10)
            if r.status_code == 200:
                d = r.json()
                for sym, cg_key in (("BTC","bitcoin"),("ETH","ethereum"),("SOL","solana")):
                    if cg_key in d:
                        prices[sym]["price"]  = d[cg_key]["usd"]
                        prices[sym]["change"] = round(d[cg_key].get("usd_24h_change",0.0),2)
        except Exception: pass
    return prices


# ══════════════════════════════════════════════════════════════════════════════
# 18.  STARTUP
# ══════════════════════════════════════════════════════════════════════════════

load_bot_config()
load_state()


def validate_env() -> bool:
    warns = []
    if not _DEFAULT_BOT_CONFIG.get("GEMINI_API_KEY"):
        warns.append("GEMINI_API_KEY not set — Gemini analysis will use fallback")
    if _DEFAULT_BOT_CONFIG.get("LIVE_TRADING") and not _DEFAULT_BOT_CONFIG.get("CLOB_API_KEY"):
        warns.append("LIVE_TRADING=true but CLOB_API_KEY is empty — live orders will fail")
    if _DEFAULT_BOT_CONFIG.get("SIMULATE_PROFIT"):
        warns.append("SIMULATE_PROFIT=true — do NOT use in live trading")
    jwt_sec = _DEFAULT_BOT_CONFIG.get("JWT_SECRET")
    if not jwt_sec or jwt_sec.strip() == "" or jwt_sec == "change-me":
        warns.append("JWT_SECRET is empty or default — change it in .env before going to production")
    for w in warns:
        print(f"[WARN] {w}")
    return True