import type { NavigationState, PartialRoute } from '@react-navigation/native'
import * as Linking from 'expo-linking'
import { nanoid } from 'nanoid/non-secure'
import { startTransition } from 'react'
import type { ResultState } from '../fork/getStateFromPath'
import { resolve } from '../link/path'
import { matchDynamicName } from '../matchers'
import { assertIsReady } from '../utils/assertIsReady'
import { shouldLinkExternally } from '../utils/url'
import { rememberScrollPosition } from '../views/ScrollRestoration'
import { CLIENT_BASE_URL } from './constants'
import type { RouterStore } from './router-store'

// TODO
export const preloadingLoader = {}

function setupPreload(href: string) {
  if (preloadingLoader[href]) return
  preloadingLoader[href] = async () => {
    const loaderJSUrl = `${CLIENT_BASE_URL}/assets/${href
      .slice(1)
      .replaceAll('/', '_')}_vxrn_loader.js`
    const response = await import(loaderJSUrl)
    try {
      return await response.loader()
    } catch (err) {
      console.error(`Error preloading loader: ${err}`)
      return null
    }
  }
}

export function preloadRoute(href: string) {
  if (import.meta.env.PROD) {
    setupPreload(href)
    if (typeof preloadingLoader[href] === 'function') {
      void preloadingLoader[href]()
    }
  }
}

export function linkTo(this: RouterStore, href: string, event?: string) {
  if (shouldLinkExternally(href)) {
    Linking.openURL(href)
    return
  }

  assertIsReady(this.navigationRef)
  const navigationRef = this.navigationRef.current

  if (navigationRef == null) {
    throw new Error(
      "Couldn't find a navigation object. Is your component inside NavigationContainer?"
    )
  }

  if (!this.linking) {
    throw new Error('Attempted to link to route when no routes are present')
  }

  if (href === '..' || href === '../') {
    navigationRef.goBack()
    return
  }

  if (href.startsWith('.')) {
    // Resolve base path by merging the current segments with the params
    let base =
      this.routeInfo?.segments
        ?.map((segment) => {
          if (!segment.startsWith('[')) return segment

          if (segment.startsWith('[...')) {
            segment = segment.slice(4, -1)
            const params = this.routeInfo?.params?.[segment]
            if (Array.isArray(params)) {
              return params.join('/')
            }
            return params?.split(',')?.join('/') ?? ''
          }
          segment = segment.slice(1, -1)
          return this.routeInfo?.params?.[segment]
        })
        .filter(Boolean)
        .join('/') ?? '/'

    if (!this.routeInfo?.isIndex) {
      base += '/..'
    }

    href = resolve(base, href)
  }

  // todo
  globalThis['__vxrntodopath'] = href

  preloadRoute(href)

  const state = this.linking.getStateFromPath!(href, this.linking.config)

  if (!state || state.routes.length === 0) {
    console.error('Could not generate a valid navigation state for the given path: ' + href)
    console.error(`this.linking.config`, this.linking.config)
    console.error(`routes`, this.getSortedRoutes())
    return
  }

  const rootState = navigationRef.getRootState()
  const action = getNavigateAction(state, rootState, event)

  startTransition(() => {
    const current = navigationRef.getCurrentRoute()

    rememberScrollPosition()

    // loading state
    send('start')
    navigationRef.dispatch(action)
    let warningTm
    const interval = setInterval(() => {
      const next = navigationRef.getCurrentRoute()
      if (current !== next) {
        send('finish')
      }
      clearTimeout(warningTm)
      clearTimeout(interval)
    }, 16)
    if (process.env.NODE_ENV === 'development') {
      warningTm = setTimeout(() => {
        console.warn(`Routing took more than 8 seconds`)
      }, 1000)
    }
  })

  return
}

function send(event: 'start' | 'finish') {
  listners.forEach((l) => l(event))
}

const listners = new Set<Function>()
export function onLoadingState(l: Function) {
  listners.add(l)
  return () => {
    listners.delete(l)
  }
}

function getNavigateAction(
  actionState: ResultState,
  navigationState: NavigationState,
  type = 'NAVIGATE'
) {
  /**
   * We need to find the deepest navigator where the action and current state diverge, If they do not diverge, the
   * lowest navigator is the target.
   *
   * By default React Navigation will target the current navigator, but this doesn't work for all actions
   * For example:
   *  - /deeply/nested/route -> /top-level-route the target needs to be the top-level navigator
   *  - /stack/nestedStack/page -> /stack1/nestedStack/other-page needs to target the nestedStack navigator
   *
   * This matching needs to done by comparing the route names and the dynamic path, for example
   * - /1/page -> /2/anotherPage needs to target the /[id] navigator
   *
   * Other parameters such as search params and hash are not evaluated.
   *
   */
  let actionStateRoute: PartialRoute<any> | undefined

  // Traverse the state tree comparing the current state and the action state until we find where they diverge
  while (actionState && navigationState) {
    const stateRoute = navigationState.routes[navigationState.index]

    actionStateRoute = actionState.routes[actionState.routes.length - 1]

    const childState = actionStateRoute.state
    const nextNavigationState = stateRoute.state

    const dynamicName = matchDynamicName(actionStateRoute.name)

    const didActionAndCurrentStateDiverge =
      actionStateRoute.name !== stateRoute.name ||
      !childState ||
      !nextNavigationState ||
      (dynamicName && actionStateRoute.params?.[dynamicName] !== stateRoute.params?.[dynamicName])

    if (didActionAndCurrentStateDiverge) {
      break
    }

    actionState = childState
    navigationState = nextNavigationState as NavigationState
  }

  /*
   * We found the target navigator, but the payload is in the incorrect format
   * We need to convert the action state to a payload that can be dispatched
   */
  const rootPayload: Record<string, any> = { params: {} }
  let payload = rootPayload
  let params = payload.params

  // The root level of payload is a bit weird, its params are in the child object
  while (actionStateRoute) {
    Object.assign(params, { ...actionStateRoute.params })
    payload.screen = actionStateRoute.name

    actionStateRoute = actionStateRoute.state?.routes[actionStateRoute.state?.routes.length - 1]

    payload.params ??= {}
    payload = payload.params
    params = payload
  }

  // Expo Router uses only three actions, but these don't directly translate to all navigator actions
  if (type === 'PUSH') {
    // Only stack navigators have a push action, and even then we want to use NAVIGATE (see below)
    type = 'NAVIGATE'

    /*
     * The StackAction.PUSH does not work correctly with Expo Router.
     *
     * Expo Router provides a getId() function for every route, altering how React Navigation handles stack routing.
     * Ordinarily, PUSH always adds a new screen to the stack. However, with getId() present, it navigates to the screen with the matching ID instead (by moving the screen to the top of the stack)
     * When you try and push to a screen with the same ID, no navigation will occur
     * Refer to: https://github.com/react-navigation/react-navigation/blob/13d4aa270b301faf07960b4cd861ffc91e9b2c46/packages/routers/src/StackRouter.tsx#L279-L290
     *
     * Expo Router needs to retain the default behavior of PUSH, consistently adding new screens to the stack, even if their IDs are identical.
     *
     * To resolve this issue, we switch to using a NAVIGATE action with a new key. In the navigate action, screens are matched by either key or getId() function.
     * By generating a unique new key, we ensure that the screen is always pushed onto the stack.
     *
     */
    if (navigationState.type === 'stack') {
      rootPayload.key = `${rootPayload.name}-${nanoid()}` // @see https://github.com/react-navigation/react-navigation/blob/13d4aa270b301faf07960b4cd861ffc91e9b2c46/packages/routers/src/StackRouter.tsx#L406-L407
    }
  }

  if (type === 'REPLACE' && navigationState.type === 'tab') {
    type = 'JUMP_TO'
  }

  return {
    type,
    target: navigationState.key,
    payload: {
      key: rootPayload.key,
      name: rootPayload.screen,
      params: rootPayload.params,
    },
  }
}