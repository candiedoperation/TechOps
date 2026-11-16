from logging.config import dictConfig
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parent / "logs"
BOT_LOG = LOG_DIR / "bot.log"


def configure_logging() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "bot": {
                    "format": "%(asctime)s %(levelname)s [%(name)s] %(message)s",
                    "datefmt": "%Y-%m-%d %H:%M:%S",
                }
            },
            "handlers": {
                "bot_file": {
                    "class": "logging.handlers.RotatingFileHandler",
                    "formatter": "bot",
                    "filename": str(BOT_LOG),
                    "maxBytes": 1_000_000,
                    "backupCount": 5,
                    "encoding": "utf-8",
                    "level": "DEBUG",
                },
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "bot",
                    "level": "INFO",
                },
            },
            "root": {
                "level": "INFO",
                "handlers": ["bot_file", "console"],
            },
            "loggers": {
                "Database": {"level": "DEBUG"},
                "BusinessLogic": {"level": "DEBUG"},
                "listeners": {"level": "DEBUG"},
                "slack_bolt": {"level": "INFO"},
                "slack_sdk": {"level": "INFO"},
                "httpx": {"level": "INFO"},
                "httpcore": {"level": "WARNING"},
                "hpack": {"level": "WARNING"},
                "urllib3": {"level": "WARNING"},
            },
        }
    )
