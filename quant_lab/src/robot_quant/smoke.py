"""Import every locked optional package without requesting market data."""

from importlib import import_module


def main() -> None:
    for name in (
        "robot_quant",
        "duckdb",
        "polars",
        "pandas",
        "pyarrow",
        "psycopg",
        "ccxt",
        "yfinance",
        "vectorbt",
        "pandas_ta",
        "quantstats",
        "jupyter_core",
    ):
        import_module(name)
        print(f"{name}: OK")


if __name__ == "__main__":
    main()
