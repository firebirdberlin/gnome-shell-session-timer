#!/usr/bin/env python3
"""Bump metadata.json's version-name to today's date, or the next
sequence number if a release has already happened today."""
import json
from datetime import date

with open("metadata.json") as f:
    metadata = json.load(f)

today = date.today().strftime("%Y-%m-%d")
current = metadata.get("version-name", "")

if current == today:
    new_version_name = f"{today}-2"
elif current.startswith(f"{today}-"):
    seq = int(current.rsplit("-", 1)[1]) + 1
    new_version_name = f"{today}-{seq}"
else:
    new_version_name = today

metadata["version-name"] = new_version_name
metadata["version"] = metadata.get("version", 0) + 1

with open("metadata.json", "w") as f:
    json.dump(metadata, f, indent=2)
    f.write("\n")
