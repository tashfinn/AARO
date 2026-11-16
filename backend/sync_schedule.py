import os
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient


def parse_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
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
        start_time = settings.get("startTime", "00:00")
        try:
            start_hour, start_minute = (int(part) for part in start_time.split(":"))
            if not 0 <= start_hour <= 23 or start_minute != 0:
                raise ValueError
        except (AttributeError, TypeError, ValueError):
            start_hour, start_minute = 0, 0

        # Bangladesh is UTC+06:00 year-round. Anchor the cadence to the admin's
        # selected local start time, rather than a hard-coded midnight.
        bangladesh = timezone(timedelta(hours=6))
        now = datetime.now(bangladesh)
        anchor = datetime(1970, 1, 1, start_hour, start_minute, tzinfo=bangladesh)
        interval_seconds = interval * 60 * 60
        slot_number = int((now - anchor).total_seconds() // interval_seconds)
        slot_start = anchor + timedelta(seconds=slot_number * interval_seconds)

        latest = database.sync_runs.find_one({}, {"startedAt": 1, "updatedAt": 1, "status": 1}, sort=[("startedAt", -1)])
        latest_started = parse_timestamp((latest or {}).get("startedAt"))
        running = bool(latest and latest.get("status") == "running")
        heartbeat = parse_timestamp((latest or {}).get("updatedAt")) or latest_started
        stale_running = bool(running and heartbeat and now - heartbeat > timedelta(hours=8))
        due = (not running or stale_running) and (stale_running or latest_started is None or latest_started < slot_start)

    output_path = os.getenv("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"due={'true' if due else 'false'}\n")
            output.write(f"interval={interval}\n")
    print(f"Catalog sync interval: {interval} hours from {start_hour:02d}:{start_minute:02d} Bangladesh time; scheduled slot starts {slot_start.isoformat()}; stale run={stale_running}; due={due}.")


if __name__ == "__main__":
    main()
