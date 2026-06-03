type SpinnerProps = {
  size?: number
}

export function Spinner({ size = 12 }: SpinnerProps) {
  return (
    <span
      className="spinner"
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size }}
    />
  )
}
