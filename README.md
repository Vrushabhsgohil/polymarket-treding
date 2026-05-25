# 🤖 Polymarket AI Trading Platform

A production-ready AI-powered prediction market trading system for Polymarket, featuring automated market analysis, paper trading, and a modern web interface.

![Platform Preview](https://img.shields.io/badge/Status-Production%20Ready-success)
![Python](https://img.shields.io/badge/Python-3.9%2B-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

### 🎯 Core Capabilities
- **AI Market Analysis**: Google Gemini-powered analysis of prediction markets
- **Automated Trading**: Configure sector-specific trading strategies
- **Paper Trading**: Risk-free testing with virtual balance
- **Real-time Dashboard**: Monitor positions, P&L, and market signals
- **Manual Trading**: Execute trades with AI recommendations
- **Risk Management**: Automated take-profit and stop-loss execution

### 🛡️ Production Features
- Comprehensive error handling and logging
- Async/await for optimal performance
- Authentication & security
- Configurable via environment variables
- State persistence across restarts
- RESTful API with full documentation
- Mobile-responsive UI
- Real-time updates

## 📋 Prerequisites

- Python 3.9 or higher
- Google Gemini API key ([Get one here](https://aistudio.google.com/app/apikey))
- 1GB RAM minimum
- Linux/Mac/Windows

## 🚀 Quick Start

### 1. Clone or Download

```bash
# If using git
git clone <repository-url>
cd polymarket-ai-trading

# Or extract from archive
unzip polymarket-trading.zip
cd polymarket-trading
```

### 2. Install Dependencies

```bash
# Create virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install requirements
pip install -r requirements.txt
```

### 3. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your settings
nano .env  # or use your favorite editor
```

**Required Configuration:**
```env
GEMINI_API_KEY=your_actual_gemini_api_key
AUTH_PASSWORD=your_secure_password
```

### 4. Run the Server

```bash
# Start the server
python main.py

# Or with uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 5. Access the Platform

Open your browser and navigate to:
```
http://localhost:8000
```

Login with the password you set in `.env`

## 🎮 Usage Guide

### Starting the Bot

1. Click **"Start Engine"** in the sidebar
2. Select your target **Sector** (e.g., Politics, Sports, Crypto)
3. Optionally filter by **Subsections**
4. Click **"Start Bot With Selection"**

The bot will:
- Scan markets every 60 seconds
- Analyze opportunities using AI
- Execute trades based on confidence thresholds
- Automatically manage risk with stop-loss and take-profit

### Manual Trading

1. Navigate to **"Market Signals"**
2. Click **"Details"** on any analyzed market
3. Review AI analysis and probability estimates
4. Enter trade amount
5. Click **"Buy YES"** or **"Buy NO"**

### Monitoring

- **Dashboard**: Overview of balance, positions, and recent trades
- **Positions**: Track open positions with real-time P&L
- **Trade History**: Complete trade log with statistics
- **Market Signals**: AI analysis of current opportunities

### Configuration

Access **Settings** to customize:
- Risk parameters (take-profit, stop-loss)
- Trade sizing (base and max percentages)
- Confidence thresholds
- API keys and authentication

## 📁 Project Structure

```
polymarket-ai-trading/
├── main.py                 # FastAPI server (production-ready)
├── bot_scripts.py         # Trading logic and AI analysis
├── requirements.txt       # Python dependencies
├── .env.example          # Environment template
├── config.json           # Runtime configuration (auto-generated)
├── state.json            # Trading state (auto-generated)
├── polymarket_bot.log    # Application logs (auto-generated)
├── static/               # Frontend files
│   ├── index.html        # Main UI
│   ├── app.js            # JavaScript logic
│   └── style.css         # Styling
└── README.md             # This file
```

## 🔧 Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | - | **Required**: Google Gemini API key |
| `GEMINI_MODEL` | `gemini-2.0-flash-exp` | Gemini model to use |
| `AUTH_PASSWORD` | `admin` | Admin password (empty to disable auth) |
| `PAPER_STARTING_BALANCE` | `1000` | Starting balance for paper trading |
| `MIN_CONFIDENCE` | `60` | Minimum confidence to execute trades (0-100) |
| `TAKE_PROFIT_PERCENT` | `20` | Auto-close position at +20% profit |
| `STOP_LOSS_PERCENT` | `-12` | Auto-close position at -12% loss |
| `BASE_TRADE_SIZE` | `0.02` | Base trade size (2% of balance) |
| `MAX_TRADE_SIZE` | `0.08` | Maximum trade size (8% of balance) |

See `.env.example` for complete reference.

### Runtime Configuration

These can be modified via the **Settings** panel in the UI:
- Market scanning limits
- Analysis parameters
- Position limits
- Order size constraints

## 🔐 Security Best Practices

1. **Change Default Password**: Always set a strong `AUTH_PASSWORD`
2. **Secure API Keys**: Never commit `.env` file to version control
3. **HTTPS in Production**: Use reverse proxy (nginx) with SSL
4. **Firewall**: Restrict access to port 8000
5. **Regular Updates**: Keep dependencies updated

## 📊 API Documentation

Once running, access interactive API docs:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

### Key Endpoints

```http
POST /api/login              # Authenticate
GET  /api/status             # Bot status
POST /api/bot/start          # Start trading bot
POST /api/bot/stop           # Stop trading bot
GET  /api/balance            # Get current balance
GET  /api/positions          # Get open positions
GET  /api/history            # Get trade history
GET  /api/analyses           # Get market analyses
POST /api/trade              # Execute manual trade
GET  /api/config             # Get configuration
POST /api/config             # Update configuration
```

## 🐛 Troubleshooting

### Bot Won't Start
- Check `GEMINI_API_KEY` is valid
- Verify network connectivity
- Check logs: `tail -f polymarket_bot.log`

### No Markets Found
- Polymarket API may be rate-limiting
- Try different sector/subsections
- Check market availability on polymarket.com

### Trades Not Executing
- Verify balance is sufficient
- Check `MIN_CONFIDENCE` threshold
- Review `MIN_ORDER_USD` setting
- Ensure no duplicate positions

### Performance Issues
- Reduce `MARKETS_LIMIT`
- Lower `ANALYSIS_LIMIT_PER_ITERATION`
- Increase bot interval (modify `BOT_INTERVAL_SECONDS` in main.py)

## 📈 Performance Tips

1. **Optimize API Usage**: Reduce market limits if experiencing timeouts
2. **Efficient Sectors**: Focus on high-volume sectors for better signals
3. **Confidence Tuning**: Higher `MIN_CONFIDENCE` = fewer but higher-quality trades
4. **Position Sizing**: Conservative sizing reduces risk and improves consistency

## 🔄 Updating

```bash
# Pull latest changes
git pull origin main

# Update dependencies
pip install -r requirements.txt --upgrade

# Restart server
# State and history are preserved automatically
```

## 📝 Development

### Running in Development Mode

```bash
# Enable auto-reload
uvicorn main:app --reload --log-level debug

# Or with main.py
python main.py  # Already includes reload=True
```

### Adding Custom Analysis

Edit `bot_scripts.py` → `gemini_analyze_market()` function to customize AI prompts and analysis logic.

### Frontend Customization

Modify files in `static/`:
- `index.html` - Structure
- `style.css` - Styling
- `app.js` - Interactivity

## ⚠️ Disclaimer

**This software is for educational and research purposes only.**

- Not financial advice
- Use at your own risk
- Paper trading recommended before live trading
- Prediction markets involve risk of loss
- Past performance does not guarantee future results

## 📜 License

MIT License - See LICENSE file for details

## 🤝 Support

- **Issues**: Report bugs via GitHub Issues
- **Documentation**: Check `/docs` endpoint
- **Logs**: Review `polymarket_bot.log` for debugging

## 🎯 Roadmap

- [ ] Multi-exchange support
- [ ] Advanced charting and analytics
- [ ] Machine learning model integration
- [ ] Portfolio optimization
- [ ] Backtesting framework
- [ ] Mobile app
- [ ] Discord/Telegram notifications

## 🌟 Credits

Built with:
- [FastAPI](https://fastapi.tiangolo.com/)
- [Google Gemini](https://ai.google.dev/)
- [Polymarket](https://polymarket.com/)
- [Chart.js](https://www.chartjs.org/)

---

**Made with ❤️ for the prediction market community**

Start trading smarter with AI-powered market analysis! 🚀