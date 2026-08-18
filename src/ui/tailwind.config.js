/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		// Three-way type pairing from the Star Atlas design reference: serif
  		// display face for headings, geometric-sans for UI copy, monospace
  		// for ids/hashes/timestamps. `sans` is left as Tailwind's default so
  		// nothing that relies on it elsewhere regresses; index.css sets the
  		// UI face directly on `body`, and `font-display` is used explicitly
  		// on headings/eyebrows that want the serif treatment.
  		fontFamily: {
  			display: ['Iowan Old Style', 'Palatino Linotype', 'Palatino', 'URW Palladio L', 'Georgia', 'serif'],
  			ui: ['Optima', 'Futura', 'Century Gothic', 'URW Gothic', 'Avenir Next', '-apple-system', 'Segoe UI', 'sans-serif'],
  			mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace']
  		},
  		colors: {
  			background: 'var(--background)',
  			foreground: 'var(--foreground)',
  			card: {
  				DEFAULT: 'var(--card)',
  				foreground: 'var(--card-foreground)'
  			},
  			popover: {
  				DEFAULT: 'var(--popover)',
  				foreground: 'var(--popover-foreground)'
  			},
  			primary: {
  				DEFAULT: 'var(--primary)',
  				foreground: 'var(--primary-foreground)'
  			},
  			secondary: {
  				DEFAULT: 'var(--secondary)',
  				foreground: 'var(--secondary-foreground)'
  			},
  			muted: {
  				DEFAULT: 'var(--muted)',
  				foreground: 'var(--muted-foreground)'
  			},
  			accent: {
  				DEFAULT: 'var(--accent)',
  				foreground: 'var(--accent-foreground)'
  			},
  			destructive: {
  				DEFAULT: 'var(--destructive)',
  				foreground: 'var(--destructive-foreground)'
  			},
  			border: 'var(--border)',
  			input: 'var(--input)',
  			ring: 'var(--ring)',
  			chart: {
  				'1': 'var(--chart-1)',
  				'2': 'var(--chart-2)',
  				'3': 'var(--chart-3)',
  				'4': 'var(--chart-4)',
  				'5': 'var(--chart-5)'
  			},
  			/* Star Atlas palette, exposed as first-class Tailwind colors so
  			   views can write e.g. bg-plate, text-ink-2, border-hairline
  			   instead of reaching for var(--x) arbitrary values everywhere. */
  			void: 'var(--bg-void)',
  			plate: {
  				DEFAULT: 'var(--bg-plate)',
  				raised: 'var(--bg-plate-raised)'
  			},
  			panel: 'var(--bg-inset)',
  			hairline: {
  				DEFAULT: 'var(--line-hair)',
  				soft: 'var(--line-hair-soft)',
  				faint: 'var(--line-hair-faint)'
  			},
  			ink: {
  				1: 'var(--ink-1)',
  				2: 'var(--ink-2)',
  				3: 'var(--ink-3)'
  			},
  			capella: {
  				DEFAULT: 'var(--capella)',
  				soft: 'var(--capella-soft)',
  				line: 'var(--capella-line)'
  			},
  			star: {
  				done: 'var(--star-done)',
  				'done-soft': 'var(--star-done-soft)',
  				pending: 'var(--star-pending)',
  				'pending-soft': 'var(--star-pending-soft)',
  				progress: 'var(--star-progress)',
  				'progress-soft': 'var(--star-progress-soft)',
  				planning: 'var(--star-planning)',
  				'planning-soft': 'var(--star-planning-soft)'
  			},
  			nova: {
  				high: 'var(--nova-high)',
  				'high-soft': 'var(--nova-high-soft)',
  				mid: 'var(--nova-mid)',
  				'mid-soft': 'var(--nova-mid-soft)',
  				low: 'var(--nova-low)',
  				'low-soft': 'var(--nova-low-soft)'
  			}
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}
