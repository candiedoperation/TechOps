from typing import Annotated

from fastapi import Query

Season = Annotated[str, Query(pattern=r"^(FALL|SPRING)-(20[0-9]{2}|21[0-9]{2}|2200)$")]
