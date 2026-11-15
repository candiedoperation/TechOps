---
title: Naming
sidebar_position: 2
---

# Naming

## Conventions

| Use Case              | Convention            | Example           |
| --------------------- | --------------------- | ----------------- |
| Variables / Functions | `snake_case`          | `status_code`     |
| Files / Folders       | `snake_case`          | `auth_service.py` |
| Classes               | `UpperCamelCase`      | `DynamoDb`        |
| Constants             | `CAPITAL_SNAKE_CASE`  | `MAX_RETRIES`     |
| Private Class Members | `_leading_snake_case` | `_internal_state` |

## Abbreviations

Always treat abbreviations like words.

```python
load_http_url = "url here"  # good
load_HTTP_URL = "url here"  # avoid
```
