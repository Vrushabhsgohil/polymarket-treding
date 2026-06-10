# ═══════════════════════════════════════════════════════════════
#  Polymarket Automated Trading Bot  –  main.py
#  FastAPI server: JWT auth, bcrypt passwords, per-user isolation
# ═══════════════════════════════════════════════════════════════

from __future__ import annotations

import builtins, sys
_orig_print = builtins.print
def print(*a, **kw):
    kw["flush"] = True
    _orig_print(*a, **kw)

import os, json, re, time, asyncio, threading
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import bcrypt
import jwt as pyjwt
from fastapi import FastAPI, Depends, APIRouter, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

from bot_scripts import (
    # state
    trade_history, _history_lock, validate_env, get_balance, get_positions,
    run_bot_iteration, analyses_cache, _analyses_lock, bot_config, bot_process_state,
    update_bot_config, execute_paper_trade, get_polymarket_sectors,
    reset_simulator, fetch_queries_for_subsector, analyze_selected_queries,
    fetch_live_prices, save_bot_config, analyses_history, _analyses_history_lock,
    manual_close_paper_trade, fetch_clob_orderbook, resolve_clob_token_ids,
    get_portfolio, stop_auto_trading, resume_auto_trading, archive_position,
    get_position_logs, get_trade_history, log_operation, get_operation_logs,
    refresh_active_position_prices, current_user_var, ensure_user_data_loaded,
    _DEFAULT_BOT_CONFIG, _user_states,
)

# ── JWT helpers ──────────────────────────────────────────────────────────────

def _jwt_secret() -> str:
    sec = _DEFAULT_BOT_CONFIG.get("JWT_SECRET") or os.getenv("JWT_SECRET")
    if not sec or sec.strip() == "":
        return "change-me"
    return sec

def _make_token(username: str) -> str:
    return pyjwt.encode({"sub": username, "iat": int(time.time())},
                        _jwt_secret(), algorithm="HS256")

def _decode_token(token: str) -> str:
    payload = pyjwt.decode(token, _jwt_secret(), algorithms=["HS256"])
    return payload["sub"]

# ── Password helpers (bcrypt) ─────────────────────────────────────────────────

USERS_FILE  = "users.json"
_users_lock = threading.Lock()

def _hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def _verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        # backward-compat: plain-text passwords from old system
        return pw == hashed

def load_users() -> dict:
    with _users_lock:
        if not os.path.exists(USERS_FILE):
            default_pw = bot_config.get("AUTH_PASSWORD", "Admin@1234")
            users = {"admin": _hash_password(default_pw)}
            try:
                with open(USERS_FILE, "w", encoding="utf-8") as f:
                    json.dump(users, f, indent=2)
            except Exception as e:
                print(f"[load_users] {e}")
            return users
        try:
            with open(USERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[load_users] {e}")
            return {}

def save_users(users: dict):
    with _users_lock:
        try:
            with open(USERS_FILE, "w", encoding="utf-8") as f:
                json.dump(users, f, indent=2)
        except Exception as e:
            print(f"[save_users] {e}")

# ── Per-user bot state ────────────────────────────────────────────────────────

user_bots: Dict[str, dict] = {}

def get_user_bot_state(username: str) -> dict:
    if username not in user_bots:
        user_bots[username] = {
            "active": False, "task": None,
            "config": {"sector": None, "subsections": [], "model": "gemini", "selected_queries": []},
        }
    return user_bots[username]

# ── FastAPI lifespan ──────────────────────────────────────────────────────────

BOT_INTERVAL_SECONDS = int(os.getenv("BOT_INTERVAL_SECONDS", "120"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        validate_env()
        print("[OK] Environment validated")
    except Exception as e:
        print(f"[WARN] {e}")
    yield
    for state in user_bots.values():
        state["active"] = False
        if state.get("task"):
            state["task"].cancel()

app = FastAPI(title="Polymarket AI Trading Bot", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ── Auth ──────────────────────────────────────────────────────────────────────

security = HTTPBearer(auto_error=False)

def verify_auth(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    if not credentials:
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = credentials.credentials
    try:
        username = _decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    users = load_users()
    if username not in users:
        raise HTTPException(status_code=401, detail="User not found")
    current_user_var.set(username)
    ensure_user_data_loaded(username)
    return username

# ── Pydantic models ───────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class RegisterRequest(BaseModel):
    username: str
    password: str

class AnalysesRefreshRequest(BaseModel):
    sector: Optional[str] = "all"
    subsections: Optional[List[str]] = []
    model: Optional[str] = "gemini"
    selected_queries: Optional[List[str]] = []

class AIRecommendationRequest(BaseModel):
    model: str = "gemini"

class BotStartRequest(BaseModel):
    sector: Optional[str] = None
    subsections: List[str] = []
    model: Optional[str] = "gemini"
    selected_queries: List[str] = []

class ManualTradeRequest(BaseModel):
    question: str
    side: str
    action: str = "BUY"
    amount: float
    token_id: str
    price: float
    category: str = "Manual"

class PortfolioManualSellRequest(BaseModel):
    side: str
    amount: float
    price: float
    question: str

class AnalyzeSelectedRequest(BaseModel):
    query_ids: List[str]
    model: str = "gemini"
    markets: Optional[List[Dict[str, Any]]] = []

class AddLogRequest(BaseModel):
    action: str
    message: str
    level: str = "INFO"
    source: str = "UI"
    details: Optional[Dict[str, Any]] = None

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return FileResponse("static/index.html")

@app.post("/api/login")
def login(payload: LoginRequest):
    users = load_users()
    un = payload.username.strip()
    pw = payload.password.strip()
    if not un or not pw:
        raise HTTPException(400, "Username and password required")
    if un not in users or not _verify_password(pw, users[un]):
        raise HTTPException(401, "Invalid username or password")
    token = _make_token(un)
    return {"status": "ok", "token": token}

@app.post("/api/register")
def register(payload: RegisterRequest):
    un = payload.username.strip()
    pw = payload.password.strip()
    if not un or not pw:
        raise HTTPException(400, "Username and password required")
    if not re.match(r"^[a-zA-Z0-9_]{3,32}$", un):
        raise HTTPException(400, "Username: 3-32 alphanumeric/underscore chars only")
    if len(pw) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    users = load_users()
    if un in users:
        raise HTTPException(400, "Username already exists")
    users[un] = _hash_password(pw)
    save_users(users)
    ensure_user_data_loaded(un)
    token = _make_token(un)
    return {"status": "ok", "message": "Registered", "token": token}


api = APIRouter(prefix="/api")

# ── Bot control ───────────────────────────────────────────────────────────────

async def _bot_loop(username: str):
    interval = int(bot_config.get("BOT_INTERVAL_SECONDS", BOT_INTERVAL_SECONDS))
    while True:
        state = get_user_bot_state(username)
        if not state["active"]:
            break
        cfg = state["config"]
        try:
            await asyncio.to_thread(
                run_bot_iteration,
                cfg.get("sector"), cfg.get("subsections",[]),
                cfg.get("model","gemini"), cfg.get("selected_queries",[]),
                username,
                lambda: get_user_bot_state(username)["active"]
            )
        except Exception as e:
            print(f"[bot loop] {username}: {e}")
        # BUG FIX: respect BOT_INTERVAL_SECONDS from config (was hardcoded 60)
        interval = int(bot_config.get("BOT_INTERVAL_SECONDS", BOT_INTERVAL_SECONDS))
        await asyncio.sleep(interval)


@api.get("/status")
def status(username: str = Depends(verify_auth)):
    state = get_user_bot_state(username)
    return {
        "active":           state["active"],
        "interval_seconds": int(bot_config.get("BOT_INTERVAL_SECONDS", BOT_INTERVAL_SECONDS)),
        "config":           state["config"],
        "process_state":    dict(bot_process_state._state() if hasattr(bot_process_state, "_state") else {}),
        "logs":             get_operation_logs(limit=15),
    }

@api.get("/status")
def status_compat(username: str = Depends(verify_auth)):
    # alias (already defined above)
    return status(username)


@api.post("/bot/start")
async def start_bot(payload: BotStartRequest, username: str = Depends(verify_auth)):
    state = get_user_bot_state(username)
    if state["active"]:
        return {"active": True, "config": state["config"], "message": "Already running"}
    if not payload.sector:
        raise HTTPException(400, "sector is required")
    if not payload.selected_queries:
        raise HTTPException(400, "At least one selected query is required")
    state["config"] = {
        "sector":           payload.sector,
        "subsections":      payload.subsections or [],
        "model":            payload.model or "gemini",
        "selected_queries": payload.selected_queries or [],
    }
    state["active"] = True
    state["task"]   = asyncio.create_task(_bot_loop(username))
    log_operation("BOT_STARTED", "Bot engine started", "INFO", "USER", {"username": username})
    return {"active": True, "config": state["config"]}


@api.post("/bot/stop")
async def stop_bot(username: str = Depends(verify_auth)):
    state = get_user_bot_state(username)
    state["active"] = False
    if state.get("task"):
        state["task"].cancel()
        state["task"] = None
    log_operation("BOT_STOPPED", "Bot engine stopped", "INFO", "USER", {"username": username})
    return {"active": False}


@api.post("/bot/run-once")
async def run_once(username: str = Depends(verify_auth)):
    state  = get_user_bot_state(username)
    cfg    = state["config"]
    await asyncio.to_thread(
        run_bot_iteration,
        cfg.get("sector"), cfg.get("subsections",[]),
        cfg.get("model","gemini"), cfg.get("selected_queries",[]),
        username,
    )
    return {"status": "ok"}


# ── Market discovery ──────────────────────────────────────────────────────────

@api.get("/sectors")
def sectors(username: str = Depends(verify_auth)):
    return {"sectors": get_polymarket_sectors()}


@api.get("/queries")
def queries(sector: str, subsector: str, username: str = Depends(verify_auth)):
    try:
        return {"queries": fetch_queries_for_subsector(sector, subsector)}
    except Exception as e:
        raise HTTPException(500, str(e))


@api.post("/analyze-selected")
async def api_analyze_selected(payload: AnalyzeSelectedRequest, username: str = Depends(verify_auth)):
    if not payload.query_ids:
        raise HTTPException(400, "No query IDs provided")
    try:
        results = await asyncio.to_thread(
            analyze_selected_queries,
            payload.query_ids, payload.model,
            payload.markets or [], username,
        )
        return {"status": "ok", "results": results}
    except Exception as e:
        raise HTTPException(500, str(e))


@api.get("/ticker")
def ticker(username: str = Depends(verify_auth)):
    try:
        return {"prices": fetch_live_prices()}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Balance & positions ───────────────────────────────────────────────────────

@api.get("/balance")
async def balance(username: str = Depends(verify_auth)):
    return {"balance": await asyncio.to_thread(get_balance, username)}


@api.get("/positions")
async def positions(username: str = Depends(verify_auth)):
    await asyncio.to_thread(refresh_active_position_prices, username)
    all_pos = await asyncio.to_thread(get_positions, username)
    active  = [p for p in all_pos
               if p.get("status") in ["CREATED","ANALYZED","BUY_PLACED","BUY_FILLED",
                                       "HOLDING","PARTIAL_SELL","STOPPED"]
               and float(p.get("size", p.get("shares",0)) or 0) > 0]
    return {"positions": active}


@api.get("/portfolio")
async def portfolio(username: str = Depends(verify_auth)):
    await asyncio.to_thread(refresh_active_position_prices, username)
    return {"portfolio": await asyncio.to_thread(get_portfolio, username)}


@api.get("/portfolio/{market_id}/logs")
async def portfolio_logs(market_id: str, username: str = Depends(verify_auth)):
    logs = await asyncio.to_thread(get_position_logs, market_id, username)
    if not logs:
        raise HTTPException(404, "Position not found")
    return logs


@api.post("/portfolio/{market_id}/stop-auto-trading")
async def stop_auto(market_id: str, username: str = Depends(verify_auth)):
    ok, msg = await asyncio.to_thread(stop_auto_trading, market_id, username)
    if not ok: raise HTTPException(400, msg)
    return {"status": "ok", "message": msg}


@api.post("/portfolio/{market_id}/resume-auto-trading")
async def resume_auto(market_id: str, username: str = Depends(verify_auth)):
    ok, msg = await asyncio.to_thread(resume_auto_trading, market_id, username)
    if not ok: raise HTTPException(400, msg)
    return {"status": "ok", "message": msg}


@api.post("/portfolio/{market_id}/manual-sell")
async def manual_sell(market_id: str, payload: PortfolioManualSellRequest, username: str = Depends(verify_auth)):
    ok = await asyncio.to_thread(
        manual_close_paper_trade,
        market_id, payload.side, payload.amount, payload.price, payload.question, username)
    if not ok: raise HTTPException(400, "Manual sell failed")
    return {"status": "ok"}


@api.post("/portfolio/{market_id}/archive")
async def archive(market_id: str, username: str = Depends(verify_auth)):
    ok, msg = await asyncio.to_thread(archive_position, market_id, username)
    if not ok: raise HTTPException(400, msg)
    return {"status": "ok", "message": msg}


# ── Manual trade ──────────────────────────────────────────────────────────────

@api.post("/trade")
def manual_trade(payload: ManualTradeRequest, username: str = Depends(verify_auth)):
    if payload.action == "SELL":
        ok = manual_close_paper_trade(
            payload.token_id, payload.side, payload.amount,
            payload.price, payload.question, username)
    else:
        ok = execute_paper_trade(
            question=payload.question, side=payload.side,
            amount=payload.amount, token_id=payload.token_id,
            price=payload.price, confidence=100,
            category=payload.category,
            analysis={"reasoning": "Manual trade", "edge": 0.10,
                      "confidence": 100, "ai_probability": 100.0,
                      "market_probability": 50.0, "is_manual": True},
            username=username)
    if not ok:
        raise HTTPException(400, "Trade rejected (balance, min size, or existing position)")
    return {"status": "ok"}


# ── History / analyses ────────────────────────────────────────────────────────

@api.get("/history")
def history(username: str = Depends(verify_auth)):
    return {"history": get_trade_history(username)}


@api.get("/analyses")
def analyses(username: str = Depends(verify_auth)):
    with _analyses_lock:
        data = list(analyses_cache.values())
    return {"analyses": data}


@api.get("/analyses-history/{token_id}")
def analyses_history_ep(token_id: str, username: str = Depends(verify_auth)):
    with _analyses_history_lock:
        data = analyses_history.get(token_id, [])
    return {"history": data}


@api.post("/analyses/refresh")
async def refresh_analyses(username: str = Depends(verify_auth)):
    state = get_user_bot_state(username)
    cfg   = state["config"]
    await asyncio.to_thread(
        run_bot_iteration,
        cfg.get("sector"), cfg.get("subsections",[]),
        cfg.get("model","gemini"), cfg.get("selected_queries",[]),
        username,
    )
    return {"status": "ok"}

@api.post("/ai_recommendations")
async def ai_recommendations(req: AIRecommendationRequest, username: str = Depends(verify_auth)):
    from bot_scripts import generate_ai_recommendations
    try:
        results = await asyncio.to_thread(generate_ai_recommendations, req.model)
        return {"status": "ok", "recommendations": results}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Config ────────────────────────────────────────────────────────────────────

@api.get("/config")
def get_config(username: str = Depends(verify_auth)):
    # Strip sensitive keys from response
    safe_keys = {k: v for k, v in bot_config.items()
                 if k not in ("JWT_SECRET","CLOB_SECRET","CLOB_PASS_PHRASE")}
    return {"config": safe_keys}


def _bg_save(username: str):
    import time as _t; _t.sleep(0.5)
    current_user_var.set(username)
    save_bot_config()


@api.post("/config")
def update_config(payload: dict, bg: BackgroundTasks, username: str = Depends(verify_auth)):
    try:
        # Block writing sensitive keys from UI
        for blocked in ("JWT_SECRET","AUTH_PASSWORD"):
            payload.pop(blocked, None)
        update_bot_config(payload, save=False)
        bg.add_task(_bg_save, username)
        return {"status": "ok", "config": {k:v for k,v in bot_config.items()
                                            if k not in ("JWT_SECRET","CLOB_SECRET","CLOB_PASS_PHRASE")}}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Simulator reset ───────────────────────────────────────────────────────────

@api.post("/reset")
def reset(username: str = Depends(verify_auth)):
    if bot_config.get("LIVE_TRADING"):
        raise HTTPException(400, "Cannot reset in LIVE TRADING mode")
    try:
        state = get_user_bot_state(username)
        state["active"] = False
        if state.get("task"):
            state["task"].cancel()
            state["task"] = None
        reset_simulator()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Orderbook ─────────────────────────────────────────────────────────────────

@api.get("/orderbook/{market_id}")
async def orderbook(market_id: str, username: str = Depends(verify_auth)):
    try:
        clob_ids = await asyncio.to_thread(resolve_clob_token_ids, market_id)
        if not clob_ids or len(clob_ids) < 2:
            raise HTTPException(404, "Could not resolve CLOB token IDs")
        yes_book = await asyncio.to_thread(fetch_clob_orderbook, str(clob_ids[0]))
        no_book  = await asyncio.to_thread(fetch_clob_orderbook, str(clob_ids[1]))
        return {
            "clob_token_ids": clob_ids,
            "yes": yes_book or {"bids":[],"asks":[]},
            "no":  no_book  or {"bids":[],"asks":[]},
        }
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Logs ──────────────────────────────────────────────────────────────────────

@api.get("/logs")
def api_logs(limit: int = 200, username: str = Depends(verify_auth)):
    return {"logs": get_operation_logs(limit)}


@api.post("/logs")
def api_add_log(payload: AddLogRequest, username: str = Depends(verify_auth)):
    log_operation(
        action=payload.action, message=payload.message,
        level=payload.level, source=payload.source,
        details={**(payload.details or {}), "username": username})
    return {"status": "ok"}


# ── Terms (no-op endpoint for frontend) ──────────────────────────────────────

@api.post("/accept-terms")
def accept_terms(username: str = Depends(verify_auth)):
    return {"status": "ok"}


app.include_router(api)