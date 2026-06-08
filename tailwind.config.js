/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './client/public/index.html',
    './client/public/app.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:  ['"DM Sans"', 'sans-serif'],
        serif: ['"DM Serif Display"', 'serif'],
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(20px) scale(0.96)' },
          to:   { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        toastIn: {
          from: { opacity: '0', transform: 'translateX(-50%) translateY(-10px) scale(0.95)' },
          to:   { opacity: '1', transform: 'translateX(-50%) translateY(0) scale(1)' },
        },
        toastOut: {
          from: { opacity: '1' },
          to:   { opacity: '0', transform: 'translateX(-50%) translateY(-10px)' },
        },
        floatUp: {
          '0%':   { opacity: '1', transform: 'translateY(0) scale(1)' },
          '80%':  { opacity: '0.8' },
          '100%': { opacity: '0', transform: 'translateY(-120px) scale(1.4)' },
        },
        pulseGlow: {
          '0%, 100%': { filter: 'drop-shadow(0 0 8px rgba(255,100,100,0.4))' },
          '50%':      { filter: 'drop-shadow(0 0 18px rgba(255,100,100,0.7))' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.4' },
        },
      },
      animation: {
        'fade-in':      'fadeIn 0.6s ease both',
        'fade-in-fast': 'fadeIn 0.2s ease both',
        'slide-up':     'slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'float-up':     'floatUp 2.5s ease-out forwards',
        'pulse-glow':   'pulseGlow 3s ease-in-out infinite',
        'blink':        'blink 2s ease infinite',
      },
    },
  },
  plugins: [],
}
