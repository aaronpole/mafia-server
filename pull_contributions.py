"""
Fetches your public GitHub contribution calendar (no auth/token needed) and
saves it as JSON with day-by-day activity levels plus streak stats.

Usage:
    python tools\\pull_contributions.py <your-github-username>

Writes:
    assets\\contributions.json

Note: this scrapes GitHub's own HTML fragment for the calendar. If GitHub
changes its markup, the CSS selector below (`td.ContributionCalendar-day`)
may need updating -- open the contributions URL in a browser and inspect
a day cell if this starts returning zero days.
"""
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import httpx
from lxml import html


def fetch_contributions(username: str):
    url = f"https://github.com/users/{username}/contributions"
    resp = httpx.get(url, timeout=30, headers={"User-Agent": "profile-readme-bot"})
    resp.raise_for_status()
    tree = html.fromstring(resp.text)

    days = []
    for cell in tree.cssselect("td.ContributionCalendar-day"):
        date = cell.get("data-date")
        level = cell.get("data-level")
        if date is None or level is None:
            continue
        days.append({"date": date, "level": int(level)})

    days.sort(key=lambda d: d["date"])
    return days


def compute_stats(days):
    longest_streak = 0
    running = 0
    weekday_totals = Counter()

    for day in days:
        if day["level"] > 0:
            running += 1
            longest_streak = max(longest_streak, running)
            weekday_totals[datetime.fromisoformat(day["date"]).strftime("%A")] += 1
        else:
            running = 0

    current_streak = 0
    for day in reversed(days):
        if day["level"] > 0:
            current_streak += 1
        else:
            break

    busiest = weekday_totals.most_common(1)
    busiest_day = busiest[0][0] if busiest else None

    return {
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "busiest_day": busiest_day,
        "total_contributions": sum(1 for d in days if d["level"] > 0),
    }


def main(username: str, output_path: str = "assets/contributions.json"):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    days = fetch_contributions(username)
    if not days:
        raise RuntimeError(
            "No contribution cells found -- GitHub may have changed its markup, "
            "or the username may be wrong."
        )
    stats = compute_stats(days)
    payload = {"days": days, "stats": stats}
    Path(output_path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {output_path} ({len(days)} days) stats={stats}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python tools\\pull_contributions.py <github-username>")
        sys.exit(1)
    main(sys.argv[1])
