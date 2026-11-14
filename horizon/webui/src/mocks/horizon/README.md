# Horizon fixtures

The Vite build defaults to the fictional data source. Set
`VITE_HORIZON_DATA_SOURCE=api` before building to compile out this directory.
Use the same API origin as the UI. A deployment can set
`VITE_HORIZON_API_BASE_URL` to that explicit origin or leave it empty.

The fixture client uses the same operation parsers as the HTTP client. Dates
are relative to startup and `latencyMs` in `fixtures.ts` controls all delays.

To remove this fixture source, default `parseDataSource` to API mode, delete its
single dynamic import in `src/api/data-source.ts`, delete this directory and
remove the demo badge from the app shell. The pages and their queries need no edits.
