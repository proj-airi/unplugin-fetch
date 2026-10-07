import type { Logger } from 'vite'

import process from 'node:process'

/** What one download looks like at a given moment. */
interface TaskProgress {
  filename: string
  received: number
  /**
   * Declared size from the server: `undefined` before the response arrives, 0
   * when there is no content-length.
   */
  total: number | undefined
  lastLoggedAt: number
}

/** Only writing and a width are used, so a stand-in can be passed in from a test. */
interface ProgressStream {
  write: (chunk: string) => unknown
  columns?: number
}

interface Aggregate {
  received: number
  /** Sum of the declared sizes of the finished and running files, 0 if unknowable. */
  total: number
  /** `undefined` when no total is known, so there is no percentage to show. */
  percent: number | undefined
}

/** Redraw interval of the in-place line; anything faster only floods the terminal. */
const redrawIntervalMs = 150

/** Interval of the per-file lines printed when the output is not a terminal. */
const logIntervalMs = 1000

const minColumns = 24
const defaultColumns = 80

const minBarWidth = 4
const maxBarWidth = 32

/**
 * Columns the file name may take; anything longer is truncated to leave room
 * for the bar.
 */
const maxLabelWidth = 24

/** ⠋ ⠙ ⠹ … for a transfer that is moving but has no known end. */
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * OSC 9;4, ConEmu's progress bar sequence, which Windows Terminal shows in the
 * tab header and on the taskbar. Terminals that do not implement it ignore the
 * sequence, as OSC requires.
 *
 * @see https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences
 */
const taskbarPrefix = '\u001B]9;4;'

/**
 * One line of download progress, rewritten in place.
 *
 * Every `Download()` of a config starts downloading in `configResolved`, and
 * Vite runs those hooks through `Promise.all`, so the files transfer
 * concurrently and the progress is reported for all of them together.
 *
 * Output that is not a terminal (a pipe, CI, `--silent`) has no cursor control
 * and falls back to one line per file per second.
 */
export class DownloadProgress {
  private readonly stream: ProgressStream
  private readonly logger: Logger
  private readonly interactive: boolean
  private readonly tasks = new Map<number, TaskProgress>()

  /**
   * Files already finished. Their bytes stay in the totals, otherwise the bar
   * would jump backwards the moment one of them completes.
   */
  private completed = 0
  private completedBytes = 0
  private completedTotal = 0

  /**
   * Set once a response arrives without a content-length: a percentage of the
   * whole set means nothing then.
   */
  private noTotal = false

  private startedAt = 0
  private lastDrawnAt = 0
  /**
   * Starts at the "already hidden" key: a run that never drew sends no clear
   * sequence at the end.
   */
  private lastTaskbarKey = '0;0'
  private drawn = false
  private stopped = false

  constructor(options: {
    logger: Logger
    tasks: { id: number, filename: string }[]
    interactive: boolean
    stream?: ProgressStream
  }) {
    this.logger = options.logger
    this.interactive = options.interactive
    this.stream = options.stream ?? process.stdout

    for (const task of options.tasks) {
      this.tasks.set(task.id, {
        filename: task.filename,
        received: 0,
        total: undefined,
        lastLoggedAt: 0,
      })
    }
  }

  /** Reports progress, called once per received chunk. */
  update(id: number, received: number, total: number): void {
    const task = this.tasks.get(id)
    if (!task || this.stopped)
      return

    task.received = received
    if (total > 0) {
      task.total = total
    }
    else if (task.total === undefined) {
      // No content-length, so the percentage of the whole set is unknowable
      task.total = 0
      this.noTotal = true
    }

    if (this.startedAt === 0)
      this.startedAt = Date.now()

    // Each file logs on its own clock; one shared throttle window would starve the
    // slower one
    if (!this.interactive) {
      const now = Date.now()
      if (now - task.lastLoggedAt < logIntervalMs)
        return

      task.lastLoggedAt = now
      this.logger.info(describeTask(task))

      return
    }

    const now = Date.now()
    if (now - this.lastDrawnAt < redrawIntervalMs)
      return

    this.lastDrawnAt = now
    this.draw()
  }

  /** Marks a file as finished and folds its bytes into the completed totals. */
  complete(id: number): void {
    const task = this.tasks.get(id)
    if (!task)
      return

    this.tasks.delete(id)
    this.completed += 1
    this.completedBytes += task.received
    this.completedTotal += task.total || task.received

    if (this.tasks.size === 0)
      this.stop()
  }

  /**
   * A file served from cache never started downloading, so counting it would
   * skew the total and the percentage.
   */
  skip(id: number): void {
    this.tasks.delete(id)

    if (this.tasks.size === 0)
      this.stop()
  }

  /**
   * Writes a log line that stays, erasing the progress line first so that the
   * two do not overlap.
   */
  info(message: string): void {
    this.clearLine()
    this.logger.info(message)
  }

  /** Finishes: erase the progress line and clear the taskbar progress. */
  stop(): void {
    if (this.stopped)
      return

    this.stopped = true
    this.clearLine()
    this.setTaskbar(0, 0)
  }

  private draw(): void {
    const aggregate = this.aggregate()

    this.clearLine()
    this.stream.write(this.render(aggregate))
    this.drawn = true

    // State 1 is a known percentage, 3 is indeterminate
    this.setTaskbar(aggregate.percent === undefined ? 3 : 1, aggregate.percent ?? 0)
  }

  private aggregate(): Aggregate {
    let received = this.completedBytes
    let total = this.completedTotal
    let known = !this.noTotal

    for (const task of this.tasks.values()) {
      received += task.received
      total += task.total ?? 0

      if (!task.total)
        known = false
    }

    const percent = known && total > 0
      ? Math.min(100, Math.floor((received / total) * 100))
      : undefined

    return { received, total: known ? total : 0, percent }
  }

  private render(state: Aggregate): string {
    // Some ptys report 0 columns, so fall back to 80; minColumns covers the
    // absurd ones
    const columns = Math.max(minColumns, this.stream.columns || defaultColumns)
    const elapsed = this.startedAt > 0 ? (Date.now() - this.startedAt) / 1000 : 0
    const speed = elapsed >= 1 ? state.received / elapsed : 0
    const label = this.label()

    // With no total to go by, a spinner takes the place of "42% ██████"
    const head = state.percent === undefined
      ? spinnerFrames[Math.floor(Date.now() / 80) % spinnerFrames.length]
      : `${String(state.percent).padStart(3)}%`
    const barSlot = state.percent === undefined ? 0 : 1 + minBarWidth

    // Take the fullest combination that fits: on a narrow terminal the numbers
    // give way before the file name and the bar do
    const variants = state.percent === undefined
      ? [`${formatBytes(state.received)}${speedText(speed)}`, formatBytes(state.received), '']
      : [
          `${sizesText(state)}${speedText(speed)}${etaText(state, speed)}`,
          `${sizesText(state)}${speedText(speed)}`,
          sizesText(state),
          formatBytes(state.received),
          '',
        ]
    const labelWidth = Math.min(displayWidth(label), maxLabelWidth)
    const rest = variants.find(variant =>
      labelWidth + 2 + displayWidth(head) + barSlot + 2 + displayWidth(variant) <= columns - 1,
    ) ?? ''

    // The bar takes the space that is left, at least minBarWidth wide, which the
    // search above ensured
    const barWidth = state.percent === undefined
      ? 0
      : clamp(columns - 1 - labelWidth - 2 - displayWidth(head) - 1 - 2 - displayWidth(rest), minBarWidth, maxBarWidth)
    const middle = state.percent === undefined ? head : `${head} ${renderBar(state.percent, barWidth)}`

    const reserved = 2 + displayWidth(middle) + 2 + displayWidth(rest)
    const shown = truncateToWidth(label, Math.max(1, Math.min(maxLabelWidth, columns - 1 - reserved)))

    return `${shown}  ${middle}  ${rest}`.trimEnd()
  }

  private label(): string {
    const [only] = this.tasks.values()
    if (only && this.tasks.size === 1)
      return only.filename

    const count = this.tasks.size + this.completed

    return `${this.completed}/${count} ${count === 1 ? 'file' : 'files'}`
  }

  private clearLine(): void {
    if (!this.drawn)
      return

    // Clearing the whole line beats remembering how wide the last one was
    this.stream.write('\u001B[2K\r')
    this.drawn = false
  }

  private setTaskbar(state: number, percent: number): void {
    if (!this.interactive)
      return

    const key = `${state};${percent}`
    if (key === this.lastTaskbarKey)
      return

    this.lastTaskbarKey = key
    this.stream.write(`${taskbarPrefix}${state};${percent}\u0007`)
  }
}

function sizesText(state: Aggregate): string {
  if (state.percent === undefined)
    return formatBytes(state.received)

  return `${formatBytes(state.received)} / ${formatBytes(state.total)}`
}

function speedText(speed: number): string {
  return speed > 0 ? `  ${formatBytes(speed)}/s` : ''
}

function etaText(state: Aggregate, speed: number): string {
  if (state.percent === undefined || speed <= 0)
    return ''

  return `  ETA ${formatDuration((state.total - state.received) / speed)}`
}

function renderBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width)

  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function describeTask(task: TaskProgress): string {
  if (!task.total)
    return `${task.filename}: ${formatBytes(task.received)} received`

  const percent = Math.min(100, Math.floor((task.received / task.total) * 100))

  return `${task.filename}: ${percent}% (${formatBytes(task.received)} / ${formatBytes(task.total)})`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`

  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${units[unit]}`
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const rest = total % 60
  const minutes = Math.floor(total / 60)

  if (minutes < 60)
    return `${minutes}:${String(rest).padStart(2, '0')}`

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Estimates the columns a string takes, counting CJK, full-width characters and
 * emoji as two.
 *
 * Truncating by character count would push a CJK file name past the terminal
 * width, and a wrapped line breaks the `\r` rewrite: the cursor no longer
 * returns to the start and the progress line smears across the screen.
 */
function displayWidth(text: string): number {
  let width = 0

  for (const char of text)
    width += codePointWidth(char.codePointAt(0) ?? 0)

  return width
}

function codePointWidth(codePoint: number): number {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115F)
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x1F300 && codePoint <= 0x1FAFF)
  )
    ? 2
    : 1
}

function truncateToWidth(text: string, budget: number): string {
  if (displayWidth(text) <= budget)
    return text

  let width = 0
  let result = ''

  for (const char of text) {
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0)

    // Leave a column for the ellipsis
    if (width + charWidth > budget - 1)
      break

    width += charWidth
    result += char
  }

  return `${result}…`
}
