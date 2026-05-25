import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

/**
 * Route map. Pre-session steps (1 Initiate, 2 Profile) are real routes; the
 * in-session experience is a single shell at /s/:id that swaps the step view
 * (3 Lobby … 7 Graph) by the session's phase. See SessionShell.vue.
 *
 * Guards (profile-required, removed-screen, locked-screen, redirect-to-phase)
 * are attached in src/router/guards.ts once the stores exist.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'initiate', component: () => import('@/views/1-Initiate.vue') },
  { path: '/schedule', name: 'schedule', component: () => import('@/views/ScheduleCreate.vue') },
  { path: '/scheduled/:code', name: 'scheduled', component: () => import('@/views/ScheduledSession.vue'), props: true },
  { path: '/join/:code', name: 'join', component: () => import('@/views/JoinResolver.vue'), props: true },
  { path: '/profile/:sessionId', name: 'profile', component: () => import('@/views/2-UserProfile.vue'), props: true },
  { path: '/s/:sessionId', name: 'session', component: () => import('@/views/SessionShell.vue'), props: true },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
