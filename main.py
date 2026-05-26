import time
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, APIRouter, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from bot_scripts import (
    trade_history,
    _history_lock,
    validate_env,
    get_balance,
    get_positions,
    run_bot_iteration,
    analyses_cache,
    _analyses_lock,
    bot_config,
    update_bot_config,
    execute_paper_trade,
    get_polymarket_sectors,
    reset_simulator,
    fetch_queries_for_subsector,
    analyze_selected_queries,
    fetch_live_prices,
    save_bot_config,
    analyses_history,
    _analyses_history_lock,
    manual_close_paper_trade
)

from typing import List, Optional, Any
from pydantic import BaseModel
from fastapi import HTTPException

BOT_INTERVAL_SECONDS = 120

bot_active = False
bot_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        validate_env()
        print("[OK] Environment validated")
    except Exception as e:
        print(f"[WARN] {e}")

    yield

    global bot_active, bot_task
    bot_active = False

    if bot_task:
        bot_task.cancel()


app = FastAPI(
    title="Polymarket Gemini AI Trading Platform",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="static"), name="static")

bot_active = False
bot_task = None
current_bot_run_config = {"sector": None, "subsections": [], "model": "gemini", "selected_queries": []}


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

class LoginRequest(BaseModel):
    password: str

@app.get("/")
def root():
    return FileResponse("static/index.html")

@app.post("/api/login")
def login(payload: LoginRequest):
    req_pass = bot_config.get("AUTH_PASSWORD", "")
    if req_pass and payload.password != req_pass:
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"status": "ok", "token": payload.password if req_pass else "noauth"}


security = HTTPBearer(auto_error=False)

def verify_auth(credentials: HTTPAuthorizationCredentials = Depends(security)):
    req_pass = bot_config.get("AUTH_PASSWORD", "")
    if not req_pass:
        return True
    if not credentials or credentials.credentials != req_pass:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return True

api_router = APIRouter(prefix="/api", dependencies=[Depends(verify_auth)])


@api_router.get("/status")
def status():
    return {
        "active": bot_active,
        "interval_seconds": BOT_INTERVAL_SECONDS,
        "config": current_bot_run_config
    }
    
@api_router.get("/sectors")
def api_sectors():
    return {"sectors": get_polymarket_sectors()}


class AnalyzeSelectedRequest(BaseModel):
    query_ids: List[str]
    model: str = "gemini"


@api_router.get("/queries")
def api_queries(sector: str, subsector: str):
    try:
        queries = fetch_queries_for_subsector(sector, subsector)
        return {"queries": queries}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/analyze-selected")
async def api_analyze_selected(payload: AnalyzeSelectedRequest):
    if not payload.query_ids:
        raise HTTPException(status_code=400, detail="No query IDs provided")
    try:
        results = await asyncio.to_thread(
            analyze_selected_queries,
            payload.query_ids,
            payload.model
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/ticker")
def api_ticker():
    try:
        return {"prices": fetch_live_prices()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/accept-terms")
def accept_terms():
    return {"status": "ok", "message": "Terms and conditions accepted."}


async def bot_loop():
    global bot_active
    while bot_active:
        try:
            await asyncio.to_thread(
                run_bot_iteration,
                current_bot_run_config.get("sector"),
                current_bot_run_config.get("subsections", []),
                current_bot_run_config.get("model", "gemini"),
                current_bot_run_config.get("selected_queries", []),
            )
        except Exception as e:
            print(f"Bot loop error: {e}")
        await asyncio.sleep(60)


@api_router.post("/bot/start")
async def start_bot(payload: BotStartRequest):
    global bot_active, bot_task, current_bot_run_config
    if bot_active:
        return {"active": True, "config": current_bot_run_config, "message": "Bot already running"}

    if not payload.sector:
        raise HTTPException(status_code=400, detail="Sector is required")
    if not payload.selected_queries:
        raise HTTPException(status_code=400, detail="At least one selected query is required to start the bot.")

    current_bot_run_config = {
        "sector": payload.sector,
        "subsections": payload.subsections or [],
        "model": payload.model or "gemini",
        "selected_queries": payload.selected_queries or [],
    }
    bot_active = True
    bot_task = asyncio.create_task(bot_loop())
    return {"active": True, "config": current_bot_run_config}


@api_router.post("/bot/stop")
async def stop_bot():
    global bot_active, bot_task
    bot_active = False
    if bot_task:
        bot_task.cancel()
        bot_task = None
    return {"active": False}


@api_router.post("/bot/run-once")
async def run_once():
    await asyncio.to_thread(
        run_bot_iteration,
        current_bot_run_config.get("sector"),
        current_bot_run_config.get("subsections", []),
        current_bot_run_config.get("model", "gemini"),
        current_bot_run_config.get("selected_queries", []),
    )
    return {"status": "ok"}


@api_router.get("/balance")
async def balance():
    return {"balance": await asyncio.to_thread(get_balance)}


@api_router.get("/positions")
async def positions():
    return {"positions": await asyncio.to_thread(get_positions)}


@api_router.get("/history")
def history():
    with _history_lock:
        data = list(trade_history)
    return {"history": data}


@api_router.get("/analyses")
def analyses():
    with _analyses_lock:
        data = list(analyses_cache.values())
    return {"analyses": data}


@api_router.get("/analyses-history/{token_id}")
def api_analyses_history(token_id: str):
    with _analyses_history_lock:
        data = analyses_history.get(token_id, [])
    return {"history": data}


@api_router.post("/analyses/refresh")
async def refresh_analyses():
    await asyncio.to_thread(
        run_bot_iteration,
        current_bot_run_config.get("sector"),
        current_bot_run_config.get("subsections", []),
        current_bot_run_config.get("model", "gemini"),
        current_bot_run_config.get("selected_queries", []),
    )
    return {"status": "ok"}


@api_router.get("/config")
def get_config():
    return {"config": bot_config}


def background_save_config():
    time.sleep(1.0)
    save_bot_config()


@api_router.post("/config")
def update_config(payload: dict, background_tasks: BackgroundTasks):
    try:
        update_bot_config(payload, save=False)
        background_tasks.add_task(background_save_config)
        return {"status": "ok", "config": bot_config}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/reset")
def reset_state():
    if bot_config.get("LIVE_TRADING"):
        raise HTTPException(status_code=400, detail="Cannot reset simulator in LIVE TRADING mode.")
    try:
        reset_simulator()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/trade")
def manual_trade(payload: ManualTradeRequest):
    if payload.action == "SELL":
        success = manual_close_paper_trade(
            token_id=payload.token_id,
            side=payload.side,
            amount=payload.amount,
            price=payload.price,
            question=payload.question
        )
    else:
        success = execute_paper_trade(
            question=payload.question,
            side=payload.side,
            amount=payload.amount,
            token_id=payload.token_id,
            price=payload.price,
            confidence=100,
            category=payload.category,
            analysis={"reasoning": "Manual Trade executed by user."}
        )
        
    if not success:
        raise HTTPException(status_code=400, detail="Trade rejected (check balance, minimum order size, or existing positions)")
    return {"status": "ok"}

app.include_router(api_router)