---
title: Naming
sidebar_position: 2
---

# Naming

## Conventions

| Use Case             | Convention            | Example                |
| -------------------- | --------------------- | ---------------------- |
| Variables / Methods  | `lowerCamelCase`      | `statusCode`           |
| Classes / Interfaces | `UpperCamelCase`      | `UserService`          |
| Files                | `UpperCamelCase`      | `UserService.java`     |
| Packages             | `lowercase`           | `com.example.utils`    |
| Constants            | `UPPER_SNAKE_CASE`    | `MAX_RETRIES`          |
| Type Parameters      | Single capital letter | `T`, `E`, `K`          |
| Private Fields       | `lowerCamelCase`      | `socialSecurityNumber` |

## Abbreviations

Always treat abbreviations like words.

```java
loadHttpUrl = "url here";  // good
loadHTTPURL = "url here";  // avoid
```

## Descriptiveness

Name variables for what they are, not their type.

```java
String name;      // good
String strName;   // bad — don't prefix with type
int retryCount;   // good
int iCount;       // bad
```
