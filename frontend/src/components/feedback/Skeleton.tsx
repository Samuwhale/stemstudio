type SkeletonProps = {
  width?: string | number
  height?: string | number
  radius?: string | number
  className?: string
}

export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  const style: React.CSSProperties = {}
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height
  if (radius !== undefined) style.borderRadius = typeof radius === 'number' ? `${radius}px` : radius
  return <div className={`skeleton-block ${className ?? ''}`} style={style} aria-hidden />
}
