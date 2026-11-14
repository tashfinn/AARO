import os
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def main():
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        raise RuntimeError("MONGODB_URI is required to check the saved catalog schedule.")

    database_name = os.getenv("MONGODB_DATABASE", "aaro")
    with MongoClient(uri, serverSelectionTimeoutMS=10000) as client:
        database = client[database_name]
        settings = database.sync_settings.find_one({"_id": "catalog-schedule"}) or {}
        interval = settings.get("intervalHours", 24)
        if interval not in (6, 12, 24, 48):
            interval = 24

        now = datetime.now(timezone.utc)
        # Bangladesh midnight is 18:00 UTC. Cadence slots stay aligned to it.
        anchor = datetime(1970, 1, 1, 18, tzinfo=timezone.utc)
        interval_seconds = interval * 60 * 60
        slot_number = int((now - anchor).total_seconds() // interval_seconds)
        slot_start = anchor + timedelta(seconds=slot_number * interval_seconds)

        latest = database.sync_runs.find_one({}, {"startedAt": 1, "status": 1}, sort=[("startedAt", -1)])
        latest_started = parse_timestamp((latest or {}).get("startedAt"))
        running = bool(latest and latest.get("status") == "running")
        due = not running and (latest_started is None or latest_started < slot_start)

    output_path = os.getenv("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"due={'true' if due else 'false'}\n")
            output.write(f"interval={interval}\n")
    print(f"Catalog sync interval: {interval} hours; scheduled slot starts {slot_start.isoformat()}; due={due}.")


if __name__ == "__main__":
    main()
