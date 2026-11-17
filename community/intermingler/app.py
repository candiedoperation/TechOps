import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]
runpy.run_path(str(ROOT / "src" / "app.py"), run_name="__main__")
