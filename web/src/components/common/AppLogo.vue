<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    :class="{ 'logo-animated': animated }"
  >
    <circle
      cx="24"
      cy="24"
      r="18"
      stroke="var(--accent-blue)"
      stroke-width="1"
      opacity="0.35"
      stroke-dasharray="4 6"
      class="logo-orbit-outer"
    />
    <circle
      cx="24"
      cy="24"
      r="12"
      stroke="var(--accent-blue)"
      stroke-width="1"
      opacity="0.25"
      stroke-dasharray="3 5"
      class="logo-orbit-inner"
    />
    <path
      d="M24 8C16 8 8 16 8 24"
      stroke="var(--accent-blue)"
      stroke-width="3"
      stroke-linecap="round"
    />
    <path
      d="M24 40C32 40 40 32 40 24"
      stroke="var(--accent-blue-hover)"
      stroke-width="3"
      stroke-linecap="round"
    />
    <circle
      cx="8"
      cy="24"
      r="3"
      fill="var(--accent-blue)"
      class="logo-node-a"
    />
    <circle
      cx="40"
      cy="24"
      r="3"
      fill="var(--accent-blue-hover)"
      class="logo-node-b"
    />
    <circle
      cx="24"
      cy="24"
      r="2"
      fill="var(--text-primary)"
      class="logo-core"
    />
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  size?: number
  animated?: boolean
}>()
</script>

<style scoped>
.logo-animated .logo-orbit-outer {
  animation: logo-orbit-cw 12s linear infinite;
  transform-origin: 24px 24px;
  will-change: transform;
}
.logo-animated .logo-orbit-inner {
  animation: logo-orbit-ccw 18s linear infinite;
  transform-origin: 24px 24px;
  will-change: transform;
}
.logo-animated .logo-node-a {
  animation: logo-pulse 2s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
  will-change: transform, opacity;
}
.logo-animated .logo-node-b {
  animation: logo-pulse 2s ease-in-out 0.5s infinite;
  transform-box: fill-box;
  transform-origin: center;
  will-change: transform, opacity;
}
.logo-animated .logo-core {
  animation: logo-core-glow 2.5s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
  will-change: transform, opacity;
}

@keyframes logo-orbit-cw { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes logo-orbit-ccw { from { transform: rotate(0deg) } to { transform: rotate(-360deg) } }
@keyframes logo-pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(2); opacity: 0.6 } }
@keyframes logo-core-glow { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(2.5); opacity: 0.4 } }

@media (prefers-reduced-motion: reduce) {
  .logo-animated .logo-orbit-outer,
  .logo-animated .logo-orbit-inner,
  .logo-animated .logo-node-a,
  .logo-animated .logo-node-b,
  .logo-animated .logo-core {
    animation: none;
  }
}
</style>
