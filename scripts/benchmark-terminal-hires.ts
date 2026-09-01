const grids = [
  { cols: 220, rows: 65, samples: 30 },
  { cols: 320, rows: 90, samples: 24 },
  { cols: 480, rows: 120, samples: 20 },
] as const

for (const grid of grids) {
  console.log(`\n${grid.cols}×${grid.rows}`)
  const child = Bun.spawn([Bun.which('bun') ?? 'bun', 'scripts/benchmark-terminal-ui.tsx'], {
    cwd: import.meta.dir + '/..',
    env: {
      ...Bun.env,
      TERMINAL_BENCH_COLS: String(grid.cols),
      TERMINAL_BENCH_ROWS: String(grid.rows),
      TERMINAL_BENCH_SAMPLES: String(grid.samples),
      TERMINAL_BENCH_REQUIRE_DIRECT: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) globalThis.process.exit(exitCode)
}
