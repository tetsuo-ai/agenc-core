import { describe, expect, it } from 'vitest'
import {
  readFullscreenEnvironmentOverride,
  resolveFullscreenEnabled,
} from '../../src/utils/fullscreen.js'

describe('fullscreen mode authority', () => {
  it.each([
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
  ] as const)('parses AGENC_NO_FLICKER=%s as %s', (value, expected) => {
    expect(
      readFullscreenEnvironmentOverride({ AGENC_NO_FLICKER: value }),
    ).toBe(expected)
  })

  it('leaves configuration authoritative for unset and unrecognized env values', () => {
    expect(readFullscreenEnvironmentOverride({})).toBeUndefined()
    expect(
      readFullscreenEnvironmentOverride({ AGENC_NO_FLICKER: 'sometimes' }),
    ).toBeUndefined()
  })

  it('gives an explicit environment override highest precedence', () => {
    expect(
      resolveFullscreenEnabled({
        environmentOverride: false,
        tmuxControlMode: false,
        configuredPreference: true,
      }),
    ).toBe(false)
    expect(
      resolveFullscreenEnabled({
        environmentOverride: true,
        tmuxControlMode: true,
        configuredPreference: false,
      }),
    ).toBe(true)
  })

  it('disables fullscreen for tmux control mode without an env override', () => {
    expect(
      resolveFullscreenEnabled({
        environmentOverride: undefined,
        tmuxControlMode: true,
        configuredPreference: true,
      }),
    ).toBe(false)
  })

  it.each([true, false])(
    'uses the explicit configured preference %s',
    configuredPreference => {
      expect(
        resolveFullscreenEnabled({
          environmentOverride: undefined,
          tmuxControlMode: false,
          configuredPreference,
        }),
      ).toBe(configuredPreference)
    },
  )

  it('defaults to enabled without a configuration authority', () => {
    expect(
      resolveFullscreenEnabled({
        environmentOverride: undefined,
        tmuxControlMode: false,
        configuredPreference: undefined,
      }),
    ).toBe(true)
  })
})
