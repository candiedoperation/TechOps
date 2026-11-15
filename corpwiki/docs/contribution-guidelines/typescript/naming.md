---
title: Naming
sidebar_position: 2
---

# Naming

## File & Folder Naming rules

- **Components (`.tsx`)** → `UpperCamelCase`  
  _Example:_ `UserProfile.tsx`

- **Custom Hooks** → `camelCase` prefixed with `use`  
  _Example:_ `useAuth.ts`, `useTabs.ts`

- **Other files & folders** → `kebab-case`  
  _Example:_ `auth-service.ts`, `api-client.ts`

## Identifier Rules

- `UpperCamelCase` → Classes, Interfaces, Types, Enums, React components  
  _Example:_ `MapPage`, `AlertProps`, `GeoJsonObject`

- `camelCase` → Variables, Parameters, Functions, Methods, Props  
  _Example:_ `onConfirm`, `isEditable`

**Note:** since python will use snake_case, it is okay to use snake_case when referring to keys
directly from a request to the backend. However this is only if it directly used, if there is
some data transformation involved, always switch to lowerCamelCase.

## Abbreviations

Always treat abbreviations like words

```typescript
let loadHttpUrl = "url here"; // good!
let loadHTTPURL = "url here"; // bad
```
