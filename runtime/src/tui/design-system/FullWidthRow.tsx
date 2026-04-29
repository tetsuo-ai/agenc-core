import * as React from 'react'
import Box from '../ink/components/Box.js'

type Props = {
  children: React.ReactNode
}

/**
 * Row that fills the full container width. Children are laid out
 * left-to-right; remaining horizontal space pushes against an empty
 * `<Box flexGrow={1} />` spacer on the right.
 */
export default function FullWidthRow({ children }: Props): React.ReactNode {
  return (
    <Box flexDirection="row" width="100%">
      {children}
      <Box flexGrow={1} />
    </Box>
  )
}
