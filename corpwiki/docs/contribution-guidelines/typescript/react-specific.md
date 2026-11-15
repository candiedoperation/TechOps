---
title: React Specific
sidebar_position: 5
---

# React Specific

1. Always use react function component as opposed to a react class component. [reference](https://www.freecodecamp.org/news/function-component-vs-class-component-in-react/)
2. Always use axios instead of fetch [reference](https://axios-http.com/docs/intro)
3. For awaiting requests vs promise syntax, default is using await syntax since it is generally
   cleaner and results in more conssitent error handling. However an exception excists for a
   useEffect hook where it is just simpler to not have to make an async arrow function inside of
   the useEffect since you can’t make the useEffect arrow function async
