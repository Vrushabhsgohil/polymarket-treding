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

_config_lock = threading.RLock()

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

def update_bot_config(new_config: dict, save: bool = True):
    global bot_config, gemini_client
    with _config_lock:
        bot_config.update(new_config)
    if save:
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
_analyses_history_lock = threading.Lock()
analyses_history: Dict[str, List[Dict[str, Any]]] = {}
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

        with _analyses_history_lock:
            analyses_history.clear()
            for k, v in data.get("analyses_history", {}).items():
                analyses_history[k] = v

        with _analyses_lock:
            analyses_cache.clear()
            for k, v in analyses_history.items():
                if v and isinstance(v, list):
                    analyses_cache[k] = v[-1]

    except Exception as e:
        print(f"{ts()} - failed to load state: {e}")


def save_state():
    try:
        with _history_lock:
            history_copy = list(trade_history)

        with _analyses_history_lock:
            analyses_history_copy = {k: list(v) for k, v in analyses_history.items()}

        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "balance": paper_balance,
                    "positions": paper_positions,
                    "history": history_copy,
                    "analyses_history": analyses_history_copy,
                },
                f,
                indent=2,
            )

    except Exception as e:
        print(f"{ts()} - failed to save state: {e}")


def reset_simulator():
    global paper_balance, paper_positions, trade_history, analyses_cache
    with _trade_lock:
        with _history_lock:
            with _analyses_lock:
                with _analyses_history_lock:
                    paper_balance = float(bot_config.get("PAPER_STARTING_BALANCE", 1000))
                    paper_positions.clear()
                    trade_history.clear()
                    analyses_cache.clear()
                    analyses_history.clear()
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
    """Dynamically fetch sectors. Uses the first tag as the main Category, and subsequent tags as Subsectors."""
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

    from collections import defaultdict, Counter
    
    category_counts = Counter()
    category_tags = defaultdict(Counter)

    for event in events:
        # 1. Safely parse the tags array
        raw_tags = event.get("tags") or []
        if isinstance(raw_tags, str):
            raw_tags = safe_json_load(raw_tags, [])
            
        parsed_tags = []
        for tag in raw_tags:
            tag_name = tag.get("label") if isinstance(tag, dict) else tag
            if tag_name and str(tag_name).lower() != "all":
                parsed_tags.append(str(tag_name))
                
        # 2. Determine the main category (prefer explicit 'category' field, fallback to the 1st tag)
        cat = event.get("category")
        if not cat and parsed_tags:
            cat = parsed_tags[0] 
            
        if not cat or str(cat).lower() == "none":
            continue
            
        category_counts[cat] += 1

        # 3. Add the remaining tags as subsectors for this category
        for tag_name in parsed_tags:
            if tag_name != cat:
                category_tags[cat][tag_name] += 1

    sectors = [{"id": "all", "name": "All Sectors", "subsections": []}]
    
    # Build the final list using the top 15 categories
    for cat, _ in category_counts.most_common(15):
        # Grab the top 10 most common sub-tags for this category
        subsections = [t for t, c in category_tags[cat].most_common(10)]
        sectors.append({
            "id": _slug(cat),
            "name": cat,
            "subsections": subsections
        })
        
    if len(sectors) <= 1:
        print(f"{ts()} - Warning: API returned no categories, using fallback.")
        return [
            {"id": "all", "name": "All Sectors", "subsections": []},
            {"id": "politics", "name": "Politics", "subsections": ["US Election", "Global Elections", "Trump"]},
            {"id": "crypto", "name": "Crypto", "subsections": ["Bitcoin", "Ethereum", "Solana", "DeFi"]},
            {"id": "sports", "name": "Sports", "subsections": ["NFL", "NBA", "Soccer", "Tennis"]},
            {"id": "pop-culture", "name": "Pop Culture", "subsections": ["Movies", "Music", "Awards"]}
        ]
        
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


def get_live_balance():
    """
    Fetches the real USDC balance from Polymarket.
    Requires Polymarket CLOB API integration/signatures.
    """
    api_key = bot_config.get("POLY_API_KEY")
    if not api_key:
        print(f"{ts()} - Missing Polymarket API Key. Cannot fetch live balance.")
        return 0.00
    
    try:
        # TODO: Implement actual Polymarket CLOB SDK / API request here.
        # Example pseudo-code:
        # client = ClobClient(host, key, secret, passphrase)
        # return client.get_balance()
        print(f"{ts()} - [LIVE MODE] Live balance fetch requires CLOB SDK implementation.")
        return 0.00 # Replace with actual live balance variable
    except Exception as e:
        print(f"{ts()} - Error fetching live balance: {e}")
        return 0.00


def get_live_positions():
    """
    Fetches actual open positions from Polymarket.
    """
    try:
        # TODO: Implement actual Polymarket CLOB SDK / API request here.
        return [] # Replace with actual live positions list
    except Exception as e:
        print(f"{ts()} - Error fetching live positions: {e}")
        return []


def get_balance():
    if bot_config.get("LIVE_TRADING"):
        return get_live_balance()
    return round(paper_balance, 2)


def get_positions():
    if bot_config.get("LIVE_TRADING"):
        return get_live_positions()
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


def process_research_with_gemini(snapshot, research_context, is_deep=False):
    if not gemini_client:
        print(f"{ts()} - Gemini client is not available for prediction.")
        return fallback_analysis(snapshot)

    model_type = "DEEP RESEARCH REPORT" if is_deep else "LIVE WEB SEARCH RESULTS"
    prompt = f"""
You are a professional prediction-market research agent for Polymarket paper trading.

Analyze this market using the provided structured market data and the {model_type}.
Do not invent facts. If external facts are missing, reduce confidence.

Your goal:
1. Estimate the real-world probability of YES using the research context.
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

{research_context}

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
        print(f"{ts()} - Gemini processing of research context failed: {e}")
        return fallback_analysis(snapshot)


def parallel_analyze_market(snapshot):
    api_key = bot_config.get("PARALLEL_API_KEY", "")
    api_base = bot_config.get("PARALLEL_API_BASE", "https://api.parallel.ai/v1")

    if not api_key:
        print(f"{ts()} - No PARALLEL_API_KEY found, falling back.")
        return fallback_analysis(snapshot)

    question = snapshot.get("question", "")
    if not question:
        return fallback_analysis(snapshot)

    search_context = ""
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
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

    return process_research_with_gemini(snapshot, search_context, is_deep=False)


def deep_research_analyze(snapshot):
    api_key = bot_config.get("PARALLEL_API_KEY", "")
    api_base = bot_config.get("PARALLEL_API_BASE", "https://api.parallel.ai/v1")

    if not api_key:
        print(f"{ts()} - No PARALLEL_API_KEY for Deep Research, using standard search-based parallel flow.")
        return parallel_analyze_market(snapshot)

    question = snapshot.get("question", "")
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "objective": f"Perform deep research on: {question}. Provide a comprehensive analysis, background context, latest news, key arguments for YES/NO outcomes, and any critical risks or dependencies.",
            "query": question
        }
        
        url = f"{api_base.rstrip('/')}/research"
        print(f"{ts()} - Initiating Parallel Deep Research for: {question} at {url}")
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
        
        if resp.status_code == 404:
            print(f"{ts()} - /research endpoint returned 404, falling back to search-based parallel flow.")
            return parallel_analyze_market(snapshot)
            
        resp.raise_for_status()
        research_data = resp.json()
        
        research_text = ""
        if isinstance(research_data, dict):
            research_text = (
                research_data.get("result") or 
                research_data.get("output") or 
                research_data.get("research") or 
                research_data.get("summary") or 
                json.dumps(research_data)
            )
        else:
            research_text = str(research_data)
            
        print(f"{ts()} - Parallel Deep Research completed successfully.")
        return process_research_with_gemini(snapshot, f"PARALLEL AI DEEP RESEARCH REPORT:\n{research_text}", is_deep=True)
        
    except Exception as e:
        print(f"{ts()} - Parallel Deep Research failed: {e}. Falling back to search-based parallel flow.")
        return parallel_analyze_market(snapshot)


def analyze_market(market, ai_model="gemini"):
    snapshot = get_market_snapshot(market)
    if ai_model == "parallel":
        ai = deep_research_analyze(snapshot)
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

    with _analyses_history_lock:
        if snapshot["id"] not in analyses_history:
            analyses_history[snapshot["id"]] = []
        analyses_history[snapshot["id"]].append(analysis)

    return analysis


def find_markets(sector: Optional[str] = None, subsections: Optional[List[str]] = None, selected_queries: Optional[List[str]] = None):
    if selected_queries:
        filtered = []
        for qid in selected_queries:
            if not qid:
                continue
            try:
                res = requests.get(f"{bot_config['GAMMA_API']}/markets/{qid}", timeout=10)
                if res.status_code == 200:
                    market = res.json()
                    yes_price, no_price = parse_prices(market)
                    if yes_price > 0 and no_price > 0:
                        filtered.append(market)
                else:
                    print(f"{ts()} - failed to fetch selected query {qid}: status {res.status_code}")
            except Exception as e:
                print(f"{ts()} - error fetching selected query {qid}: {e}")
        return filtered

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

    print(f"{ts()} - selected {len(filtered)} tradable markets for sector={sector or 'all'} subsections={subsections or []} selected_queries={selected_queries or []}")

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


def manual_close_paper_trade(token_id, side, amount, price, question):
    global paper_balance, paper_positions

    price = float(price)
    if price <= 0 or amount <= 0:
        return False

    with _trade_lock:
        for pos in paper_positions:
            if str(pos.get("token_id")) == str(token_id) and pos.get("side") == side:
                shares_held = float(pos.get("size", 0))
                cost_basis = float(pos.get("entry_price", 0))
                
                shares_to_sell = amount / price
                if shares_to_sell > shares_held + 1e-6:
                    shares_to_sell = shares_held
                    amount = shares_to_sell * price
                
                if shares_to_sell <= 1e-6:
                    return False
                
                pnl = (price - cost_basis) * shares_to_sell
                roi = ((price - cost_basis) / cost_basis) * 100 if cost_basis else 0
                
                paper_balance += amount
                pos["size"] = shares_held - shares_to_sell
                
                record = {
                    "token_id": token_id,
                    "question": question,
                    "side": f"SELL {side}",
                    "amount": round(amount, 2),
                    "entry_price": round(cost_basis, 4),
                    "exit_price": round(price, 4),
                    "price": round(price, 4),
                    "shares": round(shares_to_sell, 4),
                    "pnl": round(pnl, 2),
                    "roi": round(roi, 2),
                    "balance_after": round(paper_balance, 2),
                    "status": "Win" if pnl > 0 else "Loss",
                    "close_reason": "Manual Trade",
                    "timestamp": datetime.now().isoformat(),
                }
                
                with _history_lock:
                    trade_history.insert(0, record)
                
                if pos["size"] <= 1e-6:
                    paper_positions.remove(pos)
                    
                save_state()
                print(f"{ts()} - PAPER SELL {side} ${amount:.2f} @ ${price:.4f} | PNL=${pnl:.2f}")
                return True
                
        return False


def evaluate_active_position(pos, market, roi):
    if not gemini_client:
        return "HOLD", "No AI available"

    snapshot = get_market_snapshot(market)
    prompt = f"""
You are an expert crypto prediction market AI.
You currently hold an active position in the following market:
Question: {snapshot['question']}
Your Position: {pos.get('side')}
Entry Price: ${pos.get('entry_price', 0):.4f}
Current Price: ${snapshot['yes_price'] if pos.get('side') == 'YES' else snapshot['no_price']:.4f}
Current Unrealized ROI: {roi:+.2f}%

Market context:
Volume: {snapshot['volume']}
Liquidity: {snapshot['liquidity']}

Based on the live prices and ROI, should we HOLD this position, or SELL (Cash Out) now?
If you are in significant profit and want to secure it, choose SELL.
If you are losing heavily and want to cut losses, choose SELL.
If the position still has potential, choose HOLD.

Return ONLY a valid JSON object in this exact format:
{{
  "action": "HOLD" | "SELL",
  "reason": "short explanation for why"
}}
"""
    try:
        response = gemini_client.models.generate_content(
            model=bot_config.get("GEMINI_MODEL", "gemini-1.5-flash"),
            contents=prompt,
        )
        data = extract_json(response.text)
        action = str(data.get("action", "HOLD")).upper()
        if action not in ["HOLD", "SELL"]:
            action = "HOLD"
        reason = str(data.get("reason", "Take Profit / Stop Loss"))
        return action, reason
    except Exception as e:
        print(f"{ts()} - AI Position Eval Error: {e}")
        return "HOLD", "Error"


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
            else:
                # Dynamic AI Take-Profit / Stop-Loss evaluation
                action, reason = evaluate_active_position(pos, market, roi)
                if action == "SELL":
                    close_reason = f"AI {reason}"

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


def snipe_opportunities(markets):
    print(f"{ts()} - sniper loop checking for edges in cached analyses...")
    with _analyses_lock:
        cached_analyses = list(analyses_cache.values())
        
    for analysis in cached_analyses:
        token_id = analysis.get("token_id")
        if not token_id:
            continue
            
        # check if we already have an open position for this token
        with _trade_lock:
            already_open = any(str(p.get("token_id", "")) == str(token_id) for p in paper_positions)
        if already_open:
            continue
            
        try:
            # fetch live price
            res = requests.get(f"{bot_config['GAMMA_API']}/markets/{token_id}", timeout=5)
            if res.status_code != 200:
                continue
            market = res.json()
            if market.get("closed", False) or not market.get("active", True):
                continue
                
            yes_price, no_price = parse_prices(market)
            if yes_price <= 0 or no_price <= 0:
                continue
                
            ai_prob = analysis.get("ai_probability", 0)
            recommended_side = analysis.get("recommended_side", "HOLD")
            current_market_prob = yes_price if recommended_side == "YES" else no_price
            
            # Recalculate mathematical edge
            new_edge = ai_prob - current_market_prob
            min_edge = bot_config["MIN_CONFIDENCE"] / 100.0
            
            if new_edge >= min_edge:
                print(f"{ts()} - SNIPER HIT! {analysis.get('question')[:40]}... | New Edge: {new_edge:.2f}")
                # Execute Trade
                execute_paper_trade(
                    question=analysis.get("question"),
                    side=recommended_side,
                    amount=bot_config.get("BASE_TRADE_SIZE", 0.02) * paper_balance,
                    token_id=token_id,
                    price=current_market_prob,
                    confidence=int(new_edge * 100),
                    category=analysis.get("category"),
                    analysis=analysis
                )
        except Exception as e:
            print(f"{ts()} - Sniper error on {token_id}: {e}")

def run_bot_iteration(sector: Optional[str] = None, subsections: Optional[List[str]] = None, model: str = "gemini", selected_queries: Optional[List[str]] = None):
    """
    Executes a single pass: update positions, scan top markets, analyze using AI model, place paper trades.
    Uses ThreadPoolExecutor for concurrent market analysis.
    """
    global paper_positions

    print(f"{ts()} - scanning markets | sector={sector or 'all'} | subsections={subsections or []} | selected_queries={selected_queries or []} | ai_model={model}")

    markets = find_markets(sector=sector, subsections=subsections, selected_queries=selected_queries)
    if not markets:
        print(f"{ts()} - no markets found")
        return

    print(f"{ts()} - updating open positions")
    update_and_close_positions(markets)
    
    snipe_opportunities(markets)

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


def fetch_queries_for_subsector(sector: str, subsector: str) -> List[Dict[str, Any]]:
    """Fetch and return all active queries/markets matching the sector and subsector."""
    limit = 100
    offset = 0
    max_markets = 300
    all_flat_markets = []
    
    while len(all_flat_markets) < max_markets:
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
                
            all_flat_markets.extend(_flatten_event_markets(events))
            offset += len(events)
            if not has_more:
                break
        except Exception as e:
            print(f"{ts()} - error fetching events for subsector: {e}")
            break
            
    if not all_flat_markets:
        offset = 0
        while len(all_flat_markets) < max_markets:
            try:
                res = requests.get(
                    f"{bot_config['GAMMA_API']}/markets",
                    params={
                        "active": "true",
                        "closed": "false",
                        "limit": limit,
                        "offset": offset,
                        "order": "volume24hr",
                        "ascending": "false"
                    },
                    timeout=20,
                )
                res.raise_for_status()
                data = res.json()
                if not data:
                    break
                all_flat_markets.extend(data)
                offset += len(data)
            except Exception as e:
                print(f"{ts()} - error fetching markets fallback: {e}")
                break

    filtered_snapshots = []
    subsections = [s.strip() for s in subsector.split(',')] if subsector else []
    for m in all_flat_markets:
        if market_matches_selection(m, sector, subsections):
            yes_price, no_price = parse_prices(m)
            if yes_price <= 0 or no_price <= 0:
                continue
            snapshot = get_market_snapshot(m)
            filtered_snapshots.append(snapshot)
            
    filtered_snapshots.sort(key=lambda x: x.get("volume", 0), reverse=True)
    return filtered_snapshots


def analyze_selected_queries(query_ids: List[str], model: str) -> List[Dict[str, Any]]:
    """Fetch and run analysis on specific query IDs, returning the list of analyses, and auto-trading if criteria match."""
    results = []
    for qid in query_ids:
        try:
            res = requests.get(f"{bot_config['GAMMA_API']}/markets/{qid}", timeout=10)
            if res.status_code == 200:
                market = res.json()
                analysis = analyze_market(market, ai_model=model)
                if analysis:
                    results.append(analysis)
                    
                    # Auto-trading logic
                    side = analysis.get("recommended_side", "HOLD")
                    confidence = analysis.get("confidence", 0)
                    
                    if side != "HOLD" and confidence >= bot_config.get("MIN_CONFIDENCE", 70):
                        trade_size_percent = float(analysis.get("trade_size_percent", 0))
                        if trade_size_percent <= 0:
                            trade_size_percent = bot_config.get("BASE_TRADE_SIZE", 0.02) * 100
                            
                        balance = get_balance()
                        amount = round(balance * (trade_size_percent / 100), 2)
                        amount = max(amount, bot_config.get("MIN_ORDER_USD", 10.0))
                        
                        price = analysis["yes_price"] if side == "YES" else analysis["no_price"]
                        
                        can_trade = True
                        with _trade_lock:
                            if len(paper_positions) >= bot_config.get("MAX_POSITIONS", 10):
                                can_trade = False
                            if already_have_position(analysis["token_id"]):
                                can_trade = False
                                
                        if can_trade:
                            execute_paper_trade(
                                question=analysis["question"],
                                side=side,
                                amount=amount,
                                token_id=analysis["token_id"],
                                price=price,
                                confidence=confidence,
                                category=analysis.get("category", "Manual"),
                                analysis=analysis
                            )
            else:
                print(f"{ts()} - failed to fetch market {qid} for manual analysis: status {res.status_code}")
        except Exception as e:
            print(f"{ts()} - error analyzing selected query {qid}: {e}")
    return results


def fetch_live_prices() -> Dict[str, Any]:
    """Fetch live crypto prices from CoinGecko API and mock/fallback values for stocks/forex."""
    prices = {
        "BTC": {"price": 0.0, "change": 0.0},
        "ETH": {"price": 0.0, "change": 0.0},
        "SOL": {"price": 0.0, "change": 0.0},
        "SPY": {"price": 510.50, "change": 0.25},
        "GOLD": {"price": 2350.20, "change": -0.12},
        "EURUSD": {"price": 1.085, "change": 0.05}
    }
    
    try:
        url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            data = res.json()
            if "bitcoin" in data:
                prices["BTC"]["price"] = data["bitcoin"]["usd"]
                prices["BTC"]["change"] = round(data["bitcoin"].get("usd_24h_change", 0.0), 2)
            if "ethereum" in data:
                prices["ETH"]["price"] = data["ethereum"]["usd"]
                prices["ETH"]["change"] = round(data["ethereum"].get("usd_24h_change", 0.0), 2)
            if "solana" in data:
                prices["SOL"]["price"] = data["solana"]["usd"]
                prices["SOL"]["change"] = round(data["solana"].get("usd_24h_change", 0.0), 2)
            print(f"{ts()} - Fetched live crypto prices from CoinGecko")
        else:
            print(f"{ts()} - CoinGecko API returned status {res.status_code}, using fallback prices")
            prices["BTC"] = {"price": 67250.00, "change": 1.2}
            prices["ETH"] = {"price": 3520.00, "change": -0.8}
            prices["SOL"] = {"price": 165.50, "change": 4.5}
    except Exception as e:
        print(f"{ts()} - Error fetching live prices: {e}")
        prices["BTC"] = {"price": 67250.00, "change": 1.2}
        prices["ETH"] = {"price": 3520.00, "change": -0.8}
        prices["SOL"] = {"price": 165.50, "change": 4.5}
        
    return prices