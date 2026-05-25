import os
import re
import json
import time
import threading
from datetime import datetime
from typing import Dict, Any, List, Optional

import requests
from dotenv import load_dotenv
from google import genai

load_dotenv()

_config_lock = threading.Lock()

bot_config = {
    "GAMMA_API": os.getenv("GAMMA_API", "https://gamma-api.polymarket.com"),
    "GEMINI_API_KEY": os.getenv("GEMINI_API_KEY", ""),
    "GEMINI_MODEL": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "AUTH_PASSWORD": os.getenv("AUTH_PASSWORD", "admin"),
    "PAPER_STARTING_BALANCE": float(os.getenv("PAPER_STARTING_BALANCE", "1000")),
    "LIVE_TRADING": os.getenv("LIVE_TRADING", "false").lower() == "true",
    "MIN_CONFIDENCE": int(os.getenv("MIN_CONFIDENCE", "60")),
    "MARKETS_LIMIT": int(os.getenv("MARKETS_LIMIT", "50")),
    "ANALYSIS_LIMIT_PER_ITERATION": int(os.getenv("ANALYSIS_LIMIT_PER_ITERATION", "5")),
    "MAX_POSITIONS": int(os.getenv("MAX_POSITIONS", "250")),
    "MIN_ORDER_USD": float(os.getenv("MIN_ORDER_USD", "1")),
    "BASE_TRADE_SIZE": float(os.getenv("BASE_TRADE_SIZE", "0.02")),
    "MAX_TRADE_SIZE": float(os.getenv("MAX_TRADE_SIZE", "0.08")),
    "TAKE_PROFIT_PERCENT": float(os.getenv("TAKE_PROFIT_PERCENT", "20")),
    "STOP_LOSS_PERCENT": float(os.getenv("STOP_LOSS_PERCENT", "-12")),
    "PARALLEL_API_KEY": os.getenv("PARALLEL_API_KEY", ""),
    "PARALLEL_API_BASE": os.getenv("PARALLEL_API_BASE", "https://api.parallel.ai/v1"),
    "PARALLEL_MODEL": os.getenv("PARALLEL_MODEL", "gpt-4"),
}

def load_bot_config():
    global bot_config
    try:
        load_dotenv(override=True)
        bot_config.update({
            "GAMMA_API": os.getenv("GAMMA_API", "https://gamma-api.polymarket.com"),
            "GEMINI_API_KEY": os.getenv("GEMINI_API_KEY", ""),
            "GEMINI_MODEL": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            "AUTH_PASSWORD": os.getenv("AUTH_PASSWORD", "admin"),
            "PAPER_STARTING_BALANCE": float(os.getenv("PAPER_STARTING_BALANCE", "1000")),
            "LIVE_TRADING": os.getenv("LIVE_TRADING", "false").lower() == "true",
            "MIN_CONFIDENCE": int(os.getenv("MIN_CONFIDENCE", "60")),
            "MARKETS_LIMIT": int(os.getenv("MARKETS_LIMIT", "50")),
            "ANALYSIS_LIMIT_PER_ITERATION": int(os.getenv("ANALYSIS_LIMIT_PER_ITERATION", "5")),
            "MAX_POSITIONS": int(os.getenv("MAX_POSITIONS", "250")),
            "MIN_ORDER_USD": float(os.getenv("MIN_ORDER_USD", "1")),
            "BASE_TRADE_SIZE": float(os.getenv("BASE_TRADE_SIZE", "0.02")),
            "MAX_TRADE_SIZE": float(os.getenv("MAX_TRADE_SIZE", "0.08")),
            "TAKE_PROFIT_PERCENT": float(os.getenv("TAKE_PROFIT_PERCENT", "20")),
            "STOP_LOSS_PERCENT": float(os.getenv("STOP_LOSS_PERCENT", "-12")),
            "PARALLEL_API_KEY": os.getenv("PARALLEL_API_KEY", ""),
            "PARALLEL_API_BASE": os.getenv("PARALLEL_API_BASE", "https://api.parallel.ai/v1"),
            "PARALLEL_MODEL": os.getenv("PARALLEL_MODEL", "gpt-4"),
        })
    except Exception as e:
        print(f"Failed to load environment configuration: {e}")

def save_bot_config():
    with _config_lock:
        try:
            env_file = ".env"
            lines = []
            
            if os.path.exists(env_file):
                with open(env_file, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            
            updated_keys = set()
            new_lines = []
            
            for line in lines:
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and "=" in stripped:
                    key, val = stripped.split("=", 1)
                    key = key.strip()
                    if key in bot_config:
                        v = bot_config[key]
                        if isinstance(v, bool):
                            v_str = "true" if v else "false"
                        else:
                            v_str = str(v)
                        val_stripped = val.strip()
                        if (val_stripped.startswith('"') and val_stripped.endswith('"')) or (val_stripped.startswith("'") and val_stripped.endswith("'")):
                            quote_char = val_stripped[0]
                            v_str = f"{quote_char}{v_str}{quote_char}"
                        new_lines.append(f"{key}={v_str}\n")
                        updated_keys.add(key)
                    else:
                        new_lines.append(line)
                else:
                    new_lines.append(line)
            
            for key, v in bot_config.items():
                if key not in updated_keys:
                    if isinstance(v, bool):
                        v_str = "true" if v else "false"
                    else:
                        v_str = str(v)
                    if isinstance(v, str) and (" " in v or "=" in v or "#" in v):
                        v_str = f'"{v_str}"'
                    new_lines.append(f"{key}={v_str}\n")
            
            with open(env_file, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
                
            print(f"{ts()} - saved config to .env successfully")
        except Exception as e:
            print(f"Failed to save config to .env: {e}")

def update_bot_config(new_config: dict):
    global bot_config, gemini_client
    with _config_lock:
        bot_config.update(new_config)
    save_bot_config()
    if "GEMINI_API_KEY" in new_config:
        try:
            from google import genai
            gemini_client = genai.Client(api_key=bot_config["GEMINI_API_KEY"]) if bot_config.get("GEMINI_API_KEY") else None
        except Exception:
            gemini_client = None

load_bot_config()

STATE_FILE = "state.json"

_history_lock = threading.Lock()
trade_history: List[Dict[str, Any]] = []

_analyses_lock = threading.Lock()
analyses_cache: Dict[str, Dict[str, Any]] = {}
_trade_lock = threading.Lock()

paper_balance = bot_config["PAPER_STARTING_BALANCE"]
paper_positions: List[Dict[str, Any]] = []

gemini_client = genai.Client(api_key=bot_config["GEMINI_API_KEY"]) if bot_config.get("GEMINI_API_KEY") else None


def ts():
    return datetime.now().strftime("%H:%M:%S")


def validate_env():
    if not bot_config.get("GEMINI_API_KEY"):
        print("[WARN] GEMINI_API_KEY missing. Bot will use fallback analysis.")
    return True


def load_state():
    global paper_balance, paper_positions, trade_history

    if not os.path.exists(STATE_FILE):
        return

    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        paper_balance = float(data.get("balance", bot_config["PAPER_STARTING_BALANCE"]))
        paper_positions = data.get("positions", [])

        with _history_lock:
            trade_history.clear()
            trade_history.extend(data.get("history", []))

    except Exception as e:
        print(f"{ts()} - failed to load state: {e}")


def save_state():
    try:
        with _history_lock:
            history_copy = list(trade_history)

        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "balance": paper_balance,
                    "positions": paper_positions,
                    "history": history_copy,
                },
                f,
                indent=2,
            )

    except Exception as e:
        print(f"{ts()} - failed to save state: {e}")


def reset_simulator():
    global paper_balance, paper_positions, trade_history
    with _trade_lock:
        with _history_lock:
            paper_balance = float(bot_config.get("PAPER_STARTING_BALANCE", 1000))
            paper_positions.clear()
            trade_history.clear()
    save_state()


load_state()


def safe_json_load(value, default):
    try:
        if isinstance(value, str):
            return json.loads(value)
        return value if value is not None else default
    except Exception:
        return default


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _slug(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _norm(value)).strip("-") or "unknown"


def _tag_names(obj: Dict[str, Any]) -> List[str]:
    names = []
    for key in ("tags", "event_tags", "series"):
        raw = obj.get(key) or []
        if isinstance(raw, dict):
            raw = [raw]
        if isinstance(raw, str):
            raw = safe_json_load(raw, [])
        for tag in raw or []:
            if isinstance(tag, dict):
                name = tag.get("label") or tag.get("name") or tag.get("slug") or tag.get("title")
            else:
                name = tag
            if name:
                names.append(str(name))
    for key in ("category", "subcategory"):
        if obj.get(key):
            names.append(str(obj.get(key)))
    return list(dict.fromkeys(names))


def get_polymarket_sectors() -> List[Dict[str, Any]]:
    """Dynamically fetch sectors and subsections from active Polymarket events."""
    try:
        res = requests.get(
            f"{bot_config['GAMMA_API']}/events",
            params={"active": "true", "closed": "false", "limit": 1000},
            timeout=20,
        )
        res.raise_for_status()
        data = res.json()
        events = data.get("events") or data.get("data") or data if isinstance(data, dict) else data
    except Exception as e:
        print(f"{ts()} - dynamic sectors fetch failed: {e}")
        events = []

    from collections import Counter
    tag_counts = Counter()
    event_tags_map = []

    for event in events:
        tags = _tag_names(event)
        for t in tags:
            if t.lower() != "all":
                tag_counts[t] += 1
        event_tags_map.append(tags)

    # Pick the top 15 most frequent tags as our "Sectors"
    top_sectors = [t for t, c in tag_counts.most_common(15)]
    
    sectors = [{"id": "all", "name": "All Sectors", "subsections": []}]
    
    for sector_name in top_sectors:
        sub_counts = Counter()
        for tags in event_tags_map:
            if sector_name in tags:
                for t in tags:
                    if t != sector_name and t.lower() != "all":
                        sub_counts[t] += 1
        
        # Pick the top 10 co-occurring tags as "Subsections"
        subsections = [t for t, c in sub_counts.most_common(10)]
        sectors.append({
            "id": _slug(sector_name),
            "name": sector_name,
            "subsections": subsections
        })
        
    return sectors


def _flatten_event_markets(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    markets = []
    for event in events:
        event_tags = _tag_names(event)
        event_title = event.get("title") or event.get("question") or event.get("slug") or ""
        event_markets = event.get("markets") or []
        for market in event_markets:
            if not isinstance(market, dict):
                continue
            m = dict(market)
            m["event_title"] = event_title
            m["event_slug"] = event.get("slug")
            m["event_tags"] = event_tags
            markets.append(m)
    return markets


def get_markets():
    """Fetch active live markets. Events are preferred because they include tags/categories."""
    markets = []
    offset = 0
    limit = 100

    while len(markets) < bot_config["MARKETS_LIMIT"]:
        try:
            res = requests.get(
                f"{bot_config['GAMMA_API']}/events",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": limit,
                    "offset": offset,
                    "order": "volume_24hr",
                    "ascending": "false",
                },
                timeout=20,
            )
            res.raise_for_status()

            data = res.json()
            if isinstance(data, dict):
                events = data.get("events") or data.get("data") or []
                has_more = data.get("has_more", len(events) == limit)
            else:
                events = data
                has_more = len(events) == limit

            if not events:
                break

            markets.extend(_flatten_event_markets(events))
            offset += len(events)
            print(f"{ts()} - fetched {len(markets)} event markets")

            if not has_more:
                break
        except Exception as e:
            print(f"{ts()} - event market fetch error: {e}")
            break

    if markets:
        return markets[:bot_config["MARKETS_LIMIT"]]

    # Fallback to markets endpoint if events are unavailable.
    offset = 0
    while len(markets) < bot_config["MARKETS_LIMIT"]:
        try:
            res = requests.get(
                f"{bot_config['GAMMA_API']}/markets",
                params={"active": "true", "closed": "false", "limit": limit, "offset": offset, "order": "volume24hr", "ascending": "false"},
                timeout=20,
            )
            res.raise_for_status()
            data = res.json()
            if not data:
                break
            markets.extend(data)
            offset += len(data)
        except Exception as e:
            print(f"{ts()} - market fetch error: {e}")
            break
    return markets[:bot_config["MARKETS_LIMIT"]]


def market_matches_selection(market: Dict[str, Any], sector: Optional[str] = None, subsections: Optional[List[str]] = None) -> bool:
    if not sector or _slug(sector) == "all" or _slug(sector) == "all-sectors":
        return True

    sector_slug = _slug(sector)
    subsections = [_norm(x) for x in (subsections or []) if x and _norm(x) != "all"]

    question_blob = " ".join([
        market.get("question", ""), market.get("title", ""), market.get("event_title", ""),
        market.get("description", ""), market.get("slug", ""), " ".join(_tag_names(market)),
    ]).lower()

    def contains_word(word, text):
        if not word: return False
        return bool(re.search(r'(?<![a-z0-9])' + re.escape(word) + r'(?![a-z0-9])', text))

    sector_str = sector.replace("-", " ")
    
    sector_ok = contains_word(sector_str, question_blob)
    
    if not sector_ok:
        tags_slugs = [_slug(t) for t in _tag_names(market)]
        if sector_slug not in tags_slugs:
            return False

    if subsections:
        sub_ok = False
        tags_norm = [_norm(t) for t in _tag_names(market)]
        for sub in subsections:
            if contains_word(sub, question_blob) or sub in tags_norm:
                sub_ok = True
                break
        if not sub_ok:
            return False

    return True

def parse_prices(market):
    prices = safe_json_load(market.get("outcomePrices"), [])

    try:
        yes_price = float(prices[0])
    except Exception:
        yes_price = 0.5

    try:
        no_price = float(prices[1])
    except Exception:
        no_price = round(1 - yes_price, 4)

    return yes_price, no_price


def parse_outcomes(market):
    return safe_json_load(market.get("outcomes"), ["Yes", "No"])


def get_volume(market):
    try:
        return float(
            market.get("volume24hr")
            or market.get("volume24hrClob")
            or market.get("volume")
            or 0
        )
    except Exception:
        return 0


def get_liquidity(market):
    try:
        return float(
            market.get("liquidity")
            or market.get("liquidityClob")
            or 0
        )
    except Exception:
        return 0


def get_balance():
    return round(paper_balance, 2)


def get_positions():
    return paper_positions


def categorize_market(question: str):
    q = question.lower()

    if any(x in q for x in ["nba", "basketball", "lebron", "coach of the year"]):
        return "nba"
    if any(x in q for x in ["fifa", "world cup", "uefa", "football", "soccer"]):
        return "football"
    if any(x in q for x in ["nhl", "stanley cup", "hockey"]):
        return "nhl"
    if any(x in q for x in ["bitcoin", "btc", "ethereum", "crypto", "solana"]):
        return "crypto"
    if any(x in q for x in ["election", "president", "governor", "primary", "senate"]):
        return "politics"

    return "other"


def get_market_snapshot(market):
    yes_price, no_price = parse_prices(market)
    tag_names = _tag_names(market)
    question_text = " ".join([market.get("question", ""), market.get("event_title", ""), " ".join(tag_names)])

    return {
        "id": str(market.get("id", "")),
        "question": market.get("question", ""),
        "slug": market.get("slug", ""),
        "category": categorize_market(question_text),
        "outcomes": parse_outcomes(market),
        "yes_price": yes_price,
        "no_price": no_price,
        "market_yes_probability": round(yes_price * 100, 2),
        "market_no_probability": round(no_price * 100, 2),
        "volume": get_volume(market),
        "liquidity": get_liquidity(market),
        "spread_quality_note": "Gamma prices only. Use CLOB orderbook for true bid/ask spread before live trading.",
        "end_date": market.get("endDate") or market.get("end_date"),
        "description": market.get("description", ""),
        "event_title": market.get("event_title", ""),
        "tags": tag_names,
        "resolution_source": market.get("resolutionSource", ""),
        "url": f"https://polymarket.com/market/{market.get('slug', '')}",
    }


def extract_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("Gemini did not return valid JSON.")

    return json.loads(match.group(0))


def fallback_analysis(snapshot):
    yes_price = snapshot["yes_price"]
    volume = snapshot["volume"]
    liquidity = snapshot["liquidity"]

    if volume < 100:
        return {
            "side": "HOLD",
            "confidence": 25,
            "ai_probability": snapshot["market_yes_probability"],
            "edge": 0,
            "risk": "high",
            "trade_size_percent": 0,
            "summary": "Volume is too low for reliable paper trading.",
            "analysis_details": [
                "Market has weak trading activity.",
                "Skipping avoids low-liquidity false signals.",
            ],
        }

    if yes_price <= 0.45:
        side = "YES"
        ai_probability = min(95, snapshot["market_yes_probability"] + 8)
    elif yes_price >= 0.55:
        side = "NO"
        ai_probability = max(5, snapshot["market_yes_probability"] - 8)
    else:
        side = "HOLD"
        ai_probability = snapshot["market_yes_probability"]

    edge = (
        ai_probability - snapshot["market_yes_probability"]
        if side == "YES"
        else snapshot["market_yes_probability"] - ai_probability
    )

    confidence = int(max(30, min(80, 50 + abs(edge) + min(volume / 1000, 15) + min(liquidity / 1000, 10))))

    if side == "HOLD" or confidence < bot_config["MIN_CONFIDENCE"]:
        side = "HOLD"

    return {
        "side": side,
        "confidence": confidence,
        "ai_probability": round(ai_probability, 2),
        "edge": round(edge, 2),
        "risk": "medium",
        "trade_size_percent": 0 if side == "HOLD" else 3,
        "summary": "Fallback analysis used because Gemini is unavailable or failed.",
        "analysis_details": [
            f"Market YES probability is {snapshot['market_yes_probability']}%.",
            f"Estimated edge is {round(edge, 2)}%.",
            f"Volume is ${volume:,.2f}. Liquidity is ${liquidity:,.2f}.",
        ],
    }


def gemini_analyze_market(snapshot):
    if not gemini_client:
        return fallback_analysis(snapshot)

    prompt = f"""
You are a professional prediction-market research agent for Polymarket paper trading.

Analyze this market using only the provided structured market data.
Do not invent facts. If external facts are missing, reduce confidence.

Your goal:
1. Estimate the real-world probability of YES.
2. Compare it with market-implied probability.
3. Recommend BUY YES, BUY NO, or HOLD.
4. Give dynamic confidence from 0 to 100.
5. Explain the risk clearly.

Important:
- This is not financial advice.
- Prefer HOLD if there is no clear edge.
- Do not use fixed confidence values.
- Confidence must depend on price edge, volume, liquidity, category risk, and clarity of market question.
- trade_size_percent must be 0 for HOLD and between 1 and 8 for trades.

Market snapshot:
{json.dumps(snapshot, indent=2)}

Return ONLY valid JSON in this exact format:
{{
  "side": "YES" | "NO" | "HOLD",
  "confidence": integer,
  "ai_probability": number,
  "edge": number,
  "risk": "low" | "medium" | "high",
  "trade_size_percent": number,
  "summary": "short summary",
  "analysis_details": [
    "detail 1",
    "detail 2",
    "detail 3"
  ]
}}
"""

    try:
        response = gemini_client.models.generate_content(
            model=bot_config['GEMINI_MODEL'],
            contents=prompt,
        )

        data = extract_json(response.text)

        side = str(data.get("side", "HOLD")).upper()
        if side not in ["YES", "NO", "HOLD"]:
            side = "HOLD"

        confidence = int(float(data.get("confidence", 0)))
        confidence = max(0, min(confidence, 100))

        trade_size_percent = float(data.get("trade_size_percent", 0))
        trade_size_percent = max(0, min(trade_size_percent, 8))

        if side == "HOLD":
            trade_size_percent = 0

        return {
            "side": side,
            "confidence": confidence,
            "ai_probability": float(data.get("ai_probability", snapshot["market_yes_probability"])),
            "edge": float(data.get("edge", 0)),
            "risk": data.get("risk", "high"),
            "trade_size_percent": trade_size_percent,
            "summary": data.get("summary", ""),
            "analysis_details": data.get("analysis_details", []),
        }

    except Exception as e:
        print(f"{ts()} - Gemini analysis failed: {e}")
        return fallback_analysis(snapshot)


def parallel_analyze_market(snapshot):
    api_key = bot_config.get("PARALLEL_API_KEY", "")
    api_base = bot_config.get("PARALLEL_API_BASE", "https://api.parallel.ai/v1")

    if not api_key:
        print(f"{ts()} - No PARALLEL_API_KEY found, falling back.")
        return fallback_analysis(snapshot)

    # 1. Search the live web using Parallel AI
    question = snapshot.get("question", "")
    if not question:
        return fallback_analysis(snapshot)

    search_context = ""
    try:
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        payload = {
            "objective": f"Find the latest news, polls, or data regarding this prediction market question: {question}",
            "search_queries": [question, f"latest news {question}"]
        }
        
        search_resp = requests.post(f"{api_base.rstrip('/')}/search", headers=headers, json=payload, timeout=20)
        search_resp.raise_for_status()
        
        search_data = search_resp.json()
        results = search_data.get("results", [])
        
        excerpts = []
        for r in results[:3]:
            if "excerpts" in r and r["excerpts"]:
                excerpts.extend(r["excerpts"])
            elif "title" in r:
                excerpts.append(r["title"])
        
        if excerpts:
            search_context = "LIVE WEB SEARCH RESULTS FROM PARALLEL AI:\n- " + "\n- ".join(excerpts)
        else:
            search_context = "No recent web data found."
            
    except Exception as e:
        print(f"{ts()} - Parallel AI Search error: {e}")
        search_context = f"Parallel AI Search failed: {e}"

    # 2. Feed the context into Gemini for prediction
    prompt = f"""
You are a professional prediction-market research agent for Polymarket paper trading.

Analyze this market using the provided structured market data and the LIVE WEB SEARCH RESULTS.
Do not invent facts. If external facts are missing, reduce confidence.

Your goal:
1. Estimate the real-world probability of YES using the web search context.
2. Compare it with market-implied probability.
3. Recommend BUY YES, BUY NO, or HOLD.
4. Give dynamic confidence from 0 to 100.
5. Explain the risk clearly.

Important:
- This is not financial advice.
- Prefer HOLD if there is no clear edge.
- Do not use fixed confidence values.
- Confidence must depend on price edge, volume, liquidity, category risk, and clarity of market question.
- trade_size_percent must be 0 for HOLD and between 1 and 8 for trades.

{search_context}

Market snapshot:
{json.dumps(snapshot, indent=2)}

Return ONLY valid JSON in this exact format:
{{
  "side": "YES" | "NO" | "HOLD",
  "confidence": integer,
  "ai_probability": number,
  "edge": number,
  "risk": "low" | "medium" | "high",
  "trade_size_percent": number,
  "summary": "short summary",
  "analysis_details": [
    "detail 1",
    "detail 2",
    "detail 3"
  ]
}}
"""
    try:
        if not gemini_client:
            print(f"{ts()} - Gemini client is not available for prediction.")
            return fallback_analysis(snapshot)
            
        response = gemini_client.models.generate_content(
            model=bot_config.get("GEMINI_MODEL", "gemini-1.5-flash"),
            contents=prompt,
        )
        
        data = extract_json(response.text)

        side = str(data.get("side", "HOLD")).upper()
        if side not in ["YES", "NO", "HOLD"]:
            side = "HOLD"

        confidence = int(float(data.get("confidence", 0)))
        confidence = max(0, min(confidence, 100))

        trade_size_percent = float(data.get("trade_size_percent", 0))
        trade_size_percent = max(0, min(trade_size_percent, 8))

        if side == "HOLD":
            trade_size_percent = 0

        return {
            "side": side,
            "confidence": confidence,
            "ai_probability": float(data.get("ai_probability", snapshot["market_yes_probability"])),
            "edge": float(data.get("edge", 0)),
            "risk": data.get("risk", "high"),
            "trade_size_percent": trade_size_percent,
            "summary": data.get("summary", ""),
            "analysis_details": data.get("analysis_details", []),
        }

    except Exception as e:
        print(f"{ts()} - Parallel AI Analysis error (Gemini generation failed): {e}")
        return fallback_analysis(snapshot)


def analyze_market(market, ai_model="gemini"):
    snapshot = get_market_snapshot(market)
    if ai_model == "parallel":
        ai = parallel_analyze_market(snapshot)
    else:
        ai = gemini_analyze_market(snapshot)

    analysis = {
        "token_id": snapshot["id"],
        "question": snapshot["question"],
        "recommended_side": ai["side"],
        "confidence": ai["confidence"],
        "ai_probability": ai["ai_probability"],
        "market_probability": snapshot["market_yes_probability"],
        "edge": ai["edge"],
        "risk": ai["risk"],
        "trade_size_percent": ai["trade_size_percent"],
        "yes_price": snapshot["yes_price"],
        "no_price": snapshot["no_price"],
        "volume": snapshot["volume"],
        "liquidity": snapshot["liquidity"],
        "category": snapshot["category"],
        "reasoning": ai["summary"],
        "analysis_details": ai["analysis_details"],
        "sources": [snapshot["url"]],
        "timestamp": datetime.now().isoformat(),
        "is_ai_agent": True,
    }

    with _analyses_lock:
        analyses_cache[snapshot["id"]] = analysis

    return analysis


def find_markets(sector: Optional[str] = None, subsections: Optional[List[str]] = None):
    markets = get_markets()

    filtered = []
    for market in markets:
        question = market.get("question", "")
        if not question:
            continue

        if not market_matches_selection(market, sector, subsections):
            continue

        yes_price, no_price = parse_prices(market)
        volume = get_volume(market)

        if yes_price <= 0 or no_price <= 0:
            continue

        if volume < 50:
            continue

        filtered.append(market)

    if _slug(sector) == "new":
        filtered = sorted(filtered, key=lambda m: m.get("startDate") or m.get("createdAt") or "", reverse=True)
    else:
        filtered = sorted(filtered, key=lambda m: get_volume(m), reverse=True)

    print(f"{ts()} - selected {len(filtered)} tradable markets for sector={sector or 'all'} subsections={subsections or []}")

    limit = bot_config.get("ANALYSIS_LIMIT_PER_ITERATION", 5)
    if limit <= 0:
        limit = 5
    return filtered[:limit]


def already_have_position(token_id):
    return any(str(pos.get("token_id")) == str(token_id) for pos in paper_positions)


def execute_paper_trade(question, side, amount, token_id, price, confidence, category, analysis):
    global paper_balance, paper_positions

    price = float(price)

    if price <= 0:
        print(f"{ts()} - invalid price")
        return False

    if amount < bot_config["MIN_ORDER_USD"]:
        print(f"{ts()} - order below minimum")
        return False

    if paper_balance < amount:
        print(f"{ts()} - insufficient balance")
        return False

    if already_have_position(token_id):
        print(f"{ts()} - already have position")
        return False

    shares = amount / price
    paper_balance -= amount

    position = {
        "asset": question,
        "side": side,
        "size": shares,
        "value": amount,
        "cost": amount,
        "entry_price": price,
        "token_id": token_id,
        "confidence": confidence,
        "category": category,
        "ai_probability": analysis.get("ai_probability"),
        "market_probability": analysis.get("market_probability"),
        "edge": analysis.get("edge"),
        "risk": analysis.get("risk"),
        "timestamp": datetime.now().isoformat(),
    }

    paper_positions.append(position)

    record = {
        "token_id": token_id,
        "question": question,
        "side": side,
        "amount": round(amount, 2),
        "entry_price": round(price, 4),
        "price": round(price, 4),
        "shares": round(shares, 4),
        "confidence": confidence,
        "ai_probability": analysis.get("ai_probability"),
        "market_probability": analysis.get("market_probability"),
        "edge": analysis.get("edge"),
        "risk": analysis.get("risk"),
        "category": category,
        "reasoning": analysis.get("reasoning"),
        "analysis_details": analysis.get("analysis_details"),
        "balance_after": round(paper_balance, 2),
        "status": "Success",
        "timestamp": datetime.now().isoformat(),
    }

    with _history_lock:
        trade_history.insert(0, record)

    save_state()

    print(
        f"{ts()} - PAPER BUY {side} ${amount:.2f} "
        f"@ ${price:.4f} | confidence={confidence}% | edge={analysis.get('edge')}"
    )

    return True


def update_and_close_positions(markets=None):
    global paper_balance, paper_positions

    kept = []

    for pos in paper_positions:
        token_id = str(pos.get("token_id", ""))

        # If token_id is empty, try to resolve it from the scanned markets
        if not token_id:
            try:
                scan_markets = markets or get_markets()
                for m in scan_markets:
                    if str(m.get("question", "")).strip().lower() == str(pos.get("asset", "")).strip().lower():
                        token_id = str(m.get("id"))
                        pos["token_id"] = token_id
                        print(f"{ts()} - Resolved empty token ID for '{pos.get('asset')}' to '{token_id}'")
                        break
            except Exception as e:
                print(f"{ts()} - Error resolving empty token ID: {e}")

        if not token_id:
            kept.append(pos)
            continue

        try:
            res = requests.get(f"{bot_config['GAMMA_API']}/markets/{token_id}", timeout=10)
            if res.status_code != 200:
                print(f"{ts()} - failed to fetch market {token_id}: status {res.status_code}")
                kept.append(pos)
                continue

            market = res.json()
            yes_price, no_price = parse_prices(market)
            is_closed = market.get("closed", False)

            current_price = yes_price if pos.get("side") == "YES" else no_price

            # Handle cancelled / invalid market (payout is refund of cost)
            if yes_price == 0 and no_price == 0 and is_closed:
                current_price = pos.get("entry_price", 0)
                print(f"{ts()} - Market {token_id} closed as invalid/cancelled. Refunding cost.")

            shares = float(pos.get("size", 0))
            cost = float(pos.get("cost", 0))

            current_value = shares * current_price
            pnl = current_value - cost
            roi = (pnl / cost) * 100 if cost else 0

            pos["current_price"] = round(current_price, 4)
            pos["value"] = round(current_value, 2)
            pos["pnl"] = round(pnl, 2)
            pos["roi"] = round(roi, 2)

            close_reason = None
            if is_closed:
                close_reason = "Market Resolved"
            elif roi >= bot_config["TAKE_PROFIT_PERCENT"]:
                close_reason = "Take Profit"
            elif roi <= bot_config["STOP_LOSS_PERCENT"]:
                close_reason = "Stop Loss"

            if close_reason:
                paper_balance += current_value

                with _history_lock:
                    trade_history.insert(
                        0,
                        {
                            "token_id": token_id,
                            "question": pos.get("asset"),
                            "side": f"CLOSE {pos.get('side')}",
                            "amount": round(current_value, 2),
                            "entry_price": round(pos.get("entry_price", 0), 4),
                            "exit_price": round(current_price, 4),
                            "price": round(current_price, 4),
                            "shares": round(shares, 4),
                            "pnl": round(pnl, 2),
                            "roi": round(roi, 2),
                            "confidence": pos.get("confidence"),
                            "edge": pos.get("edge"),
                            "risk": pos.get("risk"),
                            "balance_after": round(paper_balance, 2),
                            "status": "Win" if pnl > 0 else "Loss",
                            "close_reason": close_reason,
                            "timestamp": datetime.now().isoformat(),
                        },
                    )

                print(
                    f"{ts()} - CLOSED {pos.get('side')} {pos.get('asset')} | "
                    f"{close_reason} | ROI={roi:+.2f}% | Payout=${current_value:.2f}"
                )
            else:
                kept.append(pos)

        except Exception as e:
            print(f"{ts()} - error updating position {token_id}: {e}")
            kept.append(pos)

    paper_positions = kept
    save_state()


def run_bot_iteration(sector: Optional[str] = None, subsections: Optional[List[str]] = None, model: str = "gemini"):
    """
    Executes a single pass: update positions, scan top markets, analyze using AI model, place paper trades.
    Uses ThreadPoolExecutor for concurrent market analysis.
    """
    global paper_positions

    print(f"{ts()} - scanning markets | sector={sector or 'all'} | subsections={subsections or []} | ai_model={model}")

    markets = find_markets(sector=sector, subsections=subsections)
    if not markets:
        print(f"{ts()} - no markets found")
        return

    print(f"{ts()} - updating open positions")
    update_and_close_positions(markets)

    from concurrent.futures import ThreadPoolExecutor
    
    max_to_analyze = bot_config["MAX_POSITIONS"] - len(paper_positions)
    markets_to_analyze = markets[:max_to_analyze]
    
    if not markets_to_analyze:
        print(f"{ts()} - max positions reached")
        return
    
    def analyze_and_trade(market):
        try:
            analysis = analyze_market(market, ai_model=model)
            if not analysis:
                return

            side = analysis["recommended_side"]
            confidence = analysis["confidence"]

            print("\n------------------------------------------------")
            print(analysis["question"])
            print("------------------------------------------------")
            print(
                f"{ts()} - side={side} confidence={confidence} "
                f"market_prob={analysis['market_probability']} "
                f"ai_prob={analysis['ai_probability']} edge={analysis['edge']}"
            )
            print(f"{ts()} - reason: {analysis['reasoning']}")

            if side == "HOLD":
                return

            if confidence < bot_config["MIN_CONFIDENCE"]:
                print(f"{ts()} - confidence below threshold")
                return

            trade_size_percent = float(analysis.get("trade_size_percent", 0))
            if trade_size_percent <= 0:
                trade_size_percent = bot_config["BASE_TRADE_SIZE"] * 100

            balance = get_balance()
            amount = round(balance * (trade_size_percent / 100), 2)
            amount = max(amount, bot_config["MIN_ORDER_USD"])

            price = analysis["yes_price"] if side == "YES" else analysis["no_price"]

            with _trade_lock:
                if len(paper_positions) >= bot_config["MAX_POSITIONS"]:
                    print(f"{ts()} - max positions reached")
                    return
                if already_have_position(analysis["token_id"]):
                    print(f"{ts()} - already have position for {analysis['token_id']}")
                    return

                execute_paper_trade(
                    question=analysis["question"],
                    side=side,
                    amount=amount,
                    token_id=analysis["token_id"],
                    price=price,
                    confidence=confidence,
                    category=analysis["category"],
                    analysis=analysis,
                )
        except Exception as ex:
            print(f"Error analyzing market: {ex}")

    print(f"{ts()} - {model.upper()} AI analyzing markets (Multi-threaded)")
    with ThreadPoolExecutor(max_workers=5) as executor:
        executor.map(analyze_and_trade, markets_to_analyze)

    print(f"\n{ts()} - iteration complete\n")