/**
  People Portal UI
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import React from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    useReactTable,
    type ColumnDef,
} from "@tanstack/react-table"

interface TeamStatsRow {
    teamPk: string
    name: string
    counts: Record<string, number>
    total: number
}

interface TeamStatsResponse {
    stages: string[]
    teams: TeamStatsRow[]
}

export const ActiveTeams = () => {
    const navigate = useNavigate()
    const [data, setData] = React.useState<TeamStatsResponse | null>(null)
    const [isLoading, setIsLoading] = React.useState(true)
    const [search, setSearch] = React.useState("")

    React.useEffect(() => {
        document.title = "Active Teams | App Dev Club People Portal"

        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/teamstats`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) throw new Error(res.statusText)
                return res.json()
            })
            .then((json: TeamStatsResponse) => setData(json))
            .catch(() => toast.error("Failed to load team statistics"))
            .finally(() => setIsLoading(false))
    }, [])

    const stages = React.useMemo(() => data?.stages ?? [], [data])

    /* Columns are built from the stages the API reports rather than hardcoded,
       so adding a value to ApplicationStage adds a column here on its own. */
    const columns = React.useMemo<ColumnDef<TeamStatsRow>[]>(() => [
        {
            accessorKey: "name",
            header: "Team",
            cell: ({ row }) => (
                <span className="font-medium text-sm text-foreground">{row.original.name}</span>
            ),
        },
        ...stages.map((stage): ColumnDef<TeamStatsRow> => ({
            id: stage,
            accessorFn: (r) => r.counts[stage] ?? 0,
            header: () => <div className="text-right">{stage}</div>,
            enableColumnFilter: false,
            cell: ({ row }) => {
                const n = row.original.counts[stage] ?? 0
                return (
                    <div className={`text-right tabular-nums text-sm ${n ? "text-foreground" : "text-muted-foreground"}`}>
                        {n}
                    </div>
                )
            },
        })),
        {
            id: "total",
            accessorFn: (r) => r.total,
            header: () => <div className="text-right">Total</div>,
            enableColumnFilter: false,
            cell: ({ row }) => (
                <div className="text-right font-medium tabular-nums text-sm">{row.original.total}</div>
            ),
        },
    ], [stages])

    const table = useReactTable({
        data: data?.teams ?? [],
        columns,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        state: { globalFilter: search },
        onGlobalFilterChange: setSearch,
        globalFilterFn: (row, _columnId, value) =>
            row.original.name.toLowerCase().includes(String(value).toLowerCase()),
    })

    const rows = table.getRowModel().rows

    /* Totals follow the filter rather than the full set: a total that ignored
       the search box would read as the sum of what is on screen and quietly
       not be. */
    const totals = React.useMemo(() => {
        const acc: Record<string, number> = {}
        let total = 0
        for (const stage of stages) acc[stage] = 0
        for (const { original } of rows) {
            for (const stage of stages) acc[stage] += original.counts[stage] ?? 0
            total += original.total
        }
        return { acc, total }
    }, [rows, stages])

    return (
        <div className="flex flex-col w-full h-full min-h-0">
            <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">Active Teams</h1>
            <h4 className="text-xl text-muted-foreground">Recruitment at a glance across every active team</h4>

            <div className="flex items-center justify-between py-4 mt-2 gap-4">
                <Input
                    placeholder="Search by Team Name..."
                    value={search}
                    className="max-w-md"
                    onChange={(event) => setSearch(event.target.value)}
                />
            </div>

            <div className={`flex-1 min-h-0 overflow-auto rounded-md border ${isLoading ? "opacity-50" : ""}`}>
                <Table>
                    <TableHeader className="sticky top-0 z-20 bg-background shadow-[inset_0_-1px_0_var(--border)]">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <TableHead key={header.id}>
                                        {header.isPlaceholder
                                            ? null
                                            : flexRender(header.column.columnDef.header, header.getContext())}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {rows?.length ? (
                            rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    onClick={() => { navigate(`/org/teams/${row.original.teamPk}`) }}
                                    style={{ cursor: 'pointer' }}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    {isLoading ? "Loading..." : "No results"}
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>

                    {/* Sticky like the header. Both stick to the scroll container
                        above rather than the page, since sticky resolves against
                        the nearest scrolling ancestor. The border is an inset
                        shadow because a real border on a sticky row scrolls away
                        from its own cell. */}
                    <TableFooter className="sticky bottom-0 z-20 bg-background shadow-[inset_0_1px_0_var(--border)]">
                        <TableRow className="hover:bg-transparent">
                            <TableCell className="font-medium text-sm">Total</TableCell>
                            {stages.map((stage) => (
                                <TableCell key={stage} className="text-right font-medium tabular-nums text-sm">
                                    {totals.acc[stage] ?? 0}
                                </TableCell>
                            ))}
                            <TableCell className="text-right font-medium tabular-nums text-sm">
                                {totals.total}
                            </TableCell>
                        </TableRow>
                    </TableFooter>
                </Table>
            </div>

            <div className="flex justify-end mt-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
                <span>{rows.length} of {data?.teams.length ?? 0} teams</span>
            </div>
        </div>
    )
}

export default ActiveTeams
