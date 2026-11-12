import { ArrowUpRight, Search } from 'lucide-react'

// Curated specimens from the Ken token palette; static artwork inside a project link.
const colors = ['#000000', '#b01f24', '#806ce0', '#c3c6f9', '#dfeafa']

export function DesignSystemShowcase() {
  return (
    <div role="img" aria-label="Ken Design System: typography, actual brand color tokens and interface specimens alongside the real Report Store screen" className="relative h-full w-full overflow-hidden bg-showcase [container-type:inline-size]">
      <div aria-hidden="true" className="absolute inset-x-[5%] inset-y-[8%] grid grid-cols-[0.9fr_1.1fr] gap-[3cqw]">
        <div className="flex min-w-0 flex-col justify-between rounded-[2cqw] border border-black/5 bg-white p-[3cqw] shadow-[0_10px_25px_-16px_rgba(30,37,55,0.35)]">
          <div className="flex items-center gap-[1.4cqw] text-[2.5cqw] font-medium text-black">
            <span className="flex h-[4.5cqw] w-[4.5cqw] items-center justify-center rounded-[1cqw] bg-black font-serif text-[3cqw] text-white">K</span>
            Design foundations
          </div>
          <div className="flex items-end justify-between text-black">
            <span className="font-[Georgia,serif] text-[11cqw] leading-none tracking-[-0.06em]">Aa</span>
            <span className="pb-[0.5cqw] text-[2.3cqw] leading-relaxed text-neutral-500">Display<br />Body · UI</span>
          </div>
          <div className="flex gap-[1cqw]">
            {colors.map(color => <span key={color} className="h-[4cqw] flex-1 rounded-[0.7cqw]" style={{ backgroundColor: color }} />)}
          </div>
          <div className="flex items-center gap-[1.3cqw] text-[2.3cqw] font-medium">
            <span className="flex items-center gap-[1cqw] rounded-[0.9cqw] bg-[#b01f24] px-[2cqw] py-[1.5cqw] text-white">Explore <ArrowUpRight className="h-[2.6cqw] w-[2.6cqw]" /></span>
            <span className="rounded-[0.9cqw] border border-neutral-200 px-[2cqw] py-[1.5cqw] text-black">Secondary</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-between py-[1cqw]">
          <p className="flex items-center justify-between text-[2.5cqw] font-medium text-ink-soft">Built into the product <ArrowUpRight className="h-[3cqw] w-[3cqw]" /></p>
          <div className="overflow-hidden rounded-[1.5cqw] border border-black/10 bg-white shadow-[0_12px_24px_-12px_rgba(30,37,55,0.3)]">
            <div className="flex items-center gap-[0.8cqw] border-b border-black/5 px-[2cqw] py-[1.4cqw]">
              <span className="h-[1cqw] w-[1cqw] rounded-full bg-neutral-300" /><span className="h-[1cqw] w-[1cqw] rounded-full bg-neutral-300" /><span className="ml-[1cqw] text-[2cqw] text-neutral-500">Ken Research / Report Store</span>
            </div>
            <img src="/assets/projects/market-intelligence/report-store-discovery.png" alt="" className="block w-full" loading="lazy" decoding="async" />
          </div>
          <div className="flex items-center gap-[1.5cqw] rounded-[1cqw] border border-black/10 bg-white px-[2cqw] py-[2cqw] text-[2.4cqw] text-neutral-500"><Search className="h-[3cqw] w-[3cqw]" />Search reports<span className="ml-auto rounded-[0.5cqw] bg-[#efedfd] px-[1cqw] text-[#6c5bc0]">All</span></div>
        </div>
      </div>
    </div>
  )
}
