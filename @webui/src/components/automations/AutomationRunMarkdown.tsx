import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '@/components/file-browser/MarkdownComponents'

type AutomationRunMarkdownProps = {
  content: string
}

export function AutomationRunMarkdown({ content }: AutomationRunMarkdownProps) {
  return (
    <div className="overflow-hidden">
      <div className="prose prose-invert prose-enhanced max-w-none break-words text-foreground leading-snug">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight, rehypeRaw]}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
