from __future__ import annotations

from datetime import datetime
from typing import Any, Iterator

import requests
from dateutil.parser import isoparse


REPO_NAME = "idom-team/idom"
STR_DATE_FORMAT = r"%Y-%m-%d"


def last_release_date() -> datetime:
    response = requests.get(f"https://api.github.com/repos/{REPO_NAME}/releases/latest")
    return isoparse(response.json()["published_at"])


def date_range_query(start: datetime, stop: datetime = datetime.now()) -> str:
    return start.strftime(STR_DATE_FORMAT) + ".." + stop.strftime(STR_DATE_FORMAT)


def search_idom_repo(query: str) -> Iterator[Any]:
    page = 0
    while True:
        page += 1
        response = requests.get(
            "https://api.github.com/search/issues",
            {"q": f"repo:{REPO_NAME} " + query, "per_page": 15, "page": page},
        )

        response_json = response.json()

        try:
            if response_json["incomplete_results"]:
                raise RuntimeError(response)
        except KeyError:
            raise RuntimeError(response_json)

        items = response_json["items"]
        if items:
            yield from items
        else:
            break