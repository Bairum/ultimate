import { CircleIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { defineWebExtension } from '@/sdk'

function BouncyBall() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Open bouncing ball"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-brand data-[state=open]:bg-accent data-[state=open]:text-brand"
          style={{ cursor: 'pointer' }}
          title="Bouncy ball"
          type="button"
        >
          <CircleIcon className="size-3.5 fill-current" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 overflow-hidden p-0" sideOffset={8}>
        <svg
          aria-label="A bouncing ball"
          className="block w-full bg-muted"
          role="img"
          viewBox="0 0 192 160"
        >
          <g className="text-muted-foreground" fill="currentColor">
            <ellipse cx="96" cy="138" opacity="0.18" rx="27" ry="5">
              <animate attributeName="rx" dur="1s" repeatCount="indefinite" values="16;27;16" />
              <animate
                attributeName="opacity"
                dur="1s"
                repeatCount="indefinite"
                values="0.08;0.22;0.08"
              />
            </ellipse>
          </g>
          <g className="text-brand" fill="currentColor">
            <animateTransform
              attributeName="transform"
              calcMode="spline"
              dur="1s"
              keySplines="0.35 0 0.8 0.15;0.2 0.8 0.25 1"
              keyTimes="0;0.5;1"
              repeatCount="indefinite"
              type="translate"
              values="0 0;0 90;0 0"
            />
            <circle cx="96" cy="29" r="19" />
            <circle
              className="text-background"
              cx="89"
              cy="22"
              fill="currentColor"
              opacity="0.7"
              r="5"
            />
          </g>
        </svg>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'header.right': BouncyBall },
})
