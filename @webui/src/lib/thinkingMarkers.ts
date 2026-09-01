const THINKING_STATUS_PREFIX = /^(?:Analy[sz]ing|Checking|Collecting|Compiling|Creating|Examining|Gathering|Inspecting|Looking|Preparing|Reading|Reviewing|Running|Searching|Summari[sz]ing|Updating|Verifying|Writing|Testing|Implementing|Cleaning|Comparing|Tracing|Finding|Opening|Listing|Loading|Exploring)\b/i

/** True for short progress narration that should be rendered as a Thinking marker. */
export function isThinkingMarkerText(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.length > 0 && lines.every((line) => THINKING_STATUS_PREFIX.test(line))
}
