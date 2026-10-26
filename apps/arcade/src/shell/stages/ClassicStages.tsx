import type { AroundTheClockView } from '@arcade/games/src/around-the-clock/module';
import type { CountdownView } from '@arcade/games/src/countdown/module';
import type { CricketView } from '@arcade/games/src/cricket/module';
import { AText, Avatar, TargetChips, arcade, playerColor, useLayout, withAlpha } from '@arcade/ui-kit';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { StageBoard } from './StageBoard';

/** A huge stage number: light lettering over an accent extrusion, like the title plaque. */
function Hero({ text, size, accent }: { text: string; size: number; accent: string }) {
  const style = { fontSize: size, lineHeight: Math.round(size * 1.02), letterSpacing: size * 0.01 };
  return (
    <View>
      <AText variant="hero" color={accent} align="center" style={[style, { position: 'absolute', left: 0, right: 0, top: size * 0.05 }]}>
        {text}
      </AText>
      <AText
        variant="hero"
        color={arcade.ink}
        align="center"
        style={[style, { textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: size * 0.06 }, textShadowRadius: size * 0.06 }]}
      >
        {text}
      </AText>
    </View>
  );
}

function Centered({ children, width, height }: { children: ReactNode; width: number; height: number }) {
  return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>{children}</View>;
}

/**
 * Countdown: the thrower's remaining score, very large, over a dartboard with the checkout
 * route lit, and the route as chips underneath. Chips only show while a finish is possible
 * with the darts left (`view.checkout`); the screen also hides them during takeout.
 */
export function CountdownStage({ view, width, height, accent, showRoute }: { view: CountdownView; width: number; height: number; accent: string; showRoute: boolean }) {
  const { s } = useLayout();
  const me = view.players.find((p) => p.playerId === view.current) ?? view.players[0];
  if (!me || width <= 0 || height <= 0) return null;
  const route = showRoute ? view.checkout : null;
  const chipsH = s(46);
  const board = Math.min(width * 0.98, (height - chipsH * 0.4) * 1.08);
  const digits = String(me.remaining).length;
  const hero = Math.min(height * 0.5, (width * 0.82) / (digits * 0.52));
  const bust = view.visit !== null && view.visit.playerId === view.current && view.visit.bust;
  return (
    <View style={{ width, height, alignItems: 'center' }}>
      <View style={{ position: 'absolute', top: (height - chipsH - board) / 2 + chipsH * 0.25, left: (width - board) / 2, opacity: 0.72 }}>
        <StageBoard size={board} accent={accent} highlight={route ?? []} />
      </View>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Hero text={String(me.remaining)} size={hero} accent={accent} />
        {!me.opened ? (
          <AText variant="condBold" color={accent} upper align="center">
            Double in to start
          </AText>
        ) : null}
      </View>
      <View style={{ height: chipsH, justifyContent: 'center' }}>
        {bust ? (
          <AText variant="headline" color={arcade.danger} upper>
            Bust · score stays {me.remaining}
          </AText>
        ) : route ? (
          <TargetChips labels={route} accent={accent} />
        ) : null}
      </View>
    </View>
  );
}

function Marks({ count, size, color }: { count: number; size: number; color: string }) {
  if (count <= 0) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Line x1={4} y1={16} x2={16} y2={4} stroke={color} strokeWidth={2.6} strokeLinecap="round" />
      {count >= 2 ? <Line x1={4} y1={4} x2={16} y2={16} stroke={color} strokeWidth={2.6} strokeLinecap="round" /> : null}
      {count >= 3 ? <Circle cx={10} cy={10} r={8.6} stroke={color} strokeWidth={2.2} fill="none" /> : null}
    </Svg>
  );
}

/** Cricket: the marks board, one column per player, the thrower's column lit. */
export function CricketStage({ view, width, height, accent }: { view: CricketView; width: number; height: number; accent: string }) {
  const { s } = useLayout();
  if (width <= 0 || height <= 0) return null;
  const seat = Math.max(0, view.scoreboard.findIndex((r) => r.playerId === view.current));
  const rows = view.board.length + 2;
  const rowH = Math.min(height / rows, s(40));
  const labelW = Math.min(width * 0.22, s(80));
  const colW = Math.min((width - labelW) / Math.max(1, view.scoreboard.length), s(110));
  const gridW = labelW + colW * view.scoreboard.length;
  const cell = (child: ReactNode, i: number, key: string) => (
    <View
      key={key}
      style={{ width: colW, height: rowH, alignItems: 'center', justifyContent: 'center', backgroundColor: i === seat ? withAlpha(accent, 0.18) : 'transparent' }}
    >
      {child}
    </View>
  );
  return (
    <Centered width={width} height={height}>
      <View style={{ width: gridW, borderRadius: s(8), overflow: 'hidden', backgroundColor: 'rgba(3,7,17,0.82)', borderWidth: s(1), borderColor: arcade.frameDim }}>
        <View style={{ flexDirection: 'row', borderBottomWidth: s(1), borderBottomColor: arcade.frameFaint }}>
          <View style={{ width: labelW, height: rowH }} />
          {view.scoreboard.map((p, i) =>
            cell(
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(4) }}>
                <Avatar name={p.name} colorIndex={p.colorIndex} size={rowH * 0.7} />
                <AText variant="condBold" upper numberOfLines={1} color={i === seat ? arcade.ink : arcade.inkDim} style={{ maxWidth: colW - rowH }}>
                  {p.name}
                </AText>
              </View>,
              i,
              `h${p.playerId}`,
            ),
          )}
        </View>
        {view.board.map((row) => {
          const aim = view.targets.includes(row.target);
          return (
            <View key={row.target} style={{ flexDirection: 'row', opacity: row.dead ? 0.4 : 1 }}>
              <View style={{ width: labelW, height: rowH, alignItems: 'center', justifyContent: 'center' }}>
                <AText
                  variant="headline"
                  color={aim ? accent : arcade.ink}
                  style={{ fontSize: rowH * 0.62, lineHeight: rowH * 0.75, textDecorationLine: row.dead ? 'line-through' : 'none' }}
                >
                  {row.label}
                </AText>
              </View>
              {row.marks.map((m, i) => cell(<Marks count={m} size={rowH * 0.72} color={m >= 3 ? accent : arcade.ink} />, i, `${row.target}-${i}`))}
            </View>
          );
        })}
        <View style={{ flexDirection: 'row', borderTopWidth: s(1), borderTopColor: arcade.frameFaint }}>
          <View style={{ width: labelW, height: rowH, alignItems: 'center', justifyContent: 'center' }}>
            <AText variant="kicker" color="textDim" upper>
              Points
            </AText>
          </View>
          {view.players.map((p, i) =>
            cell(
              <AText variant="headline" color={i === seat ? arcade.ink : arcade.inkDim} style={{ fontSize: rowH * 0.62, lineHeight: rowH * 0.75 }}>
                {p.points}
              </AText>,
              i,
              `p${p.playerId}`,
            ),
          )}
        </View>
      </View>
    </Centered>
  );
}

/** Around the Clock: the thrower's next target, big, inside a ring of the whole sequence. */
export function ClockStage({ view, width, height, accent }: { view: AroundTheClockView; width: number; height: number; accent: string }) {
  const { s } = useLayout();
  const me = view.players.find((p) => p.playerId === view.current) ?? view.players[0];
  if (!me || width <= 0 || height <= 0) return null;
  const size = Math.min(width, height) * 0.98;
  const r = size * 0.44;
  const dot = size * 0.07;
  const n = view.sequence.length;
  return (
    <Centered width={width} height={height}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            position: 'absolute',
            width: r * 2,
            height: r * 2,
            borderRadius: r,
            borderWidth: s(1.5),
            borderColor: arcade.frameFaint,
            backgroundColor: 'rgba(3,7,17,0.55)',
          }}
        />
        {view.sequence.map((target, i) => {
          const a = (i / n) * 2 * Math.PI;
          const done = i < me.progress;
          const next = i === me.progress;
          const d = next ? dot * 1.5 : dot;
          return (
            <View
              key={`${target}-${i}`}
              style={{
                position: 'absolute',
                left: size / 2 + r * Math.sin(a) - d / 2,
                top: size / 2 - r * Math.cos(a) - d / 2,
                width: d,
                height: d,
                borderRadius: d / 2,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: done ? accent : next ? arcade.ink : 'rgba(10,22,48,0.95)',
                borderWidth: s(1),
                borderColor: done ? accent : arcade.frameDim,
              }}
            >
              <AText variant="condBold" color={done || next ? arcade.onAccent : arcade.inkDim} style={{ fontSize: d * 0.5, lineHeight: d * 0.6 }}>
                {target === 25 ? 'B' : String(target)}
              </AText>
            </View>
          );
        })}
        <AText variant="kicker" color={accent} upper style={{ fontSize: r * 0.1, lineHeight: r * 0.12 }}>
          Next target
        </AText>
        <Hero text={me.target === 'Done' ? '✓' : me.target} size={me.target.length > 2 ? r * 0.42 : r * 0.62} accent={accent} />
        <AText variant="condBold" color="textDim" style={{ fontSize: r * 0.1, lineHeight: r * 0.13 }}>
          {`${me.progress} of ${n} done · ${me.hitRate}% hits`}
        </AText>
      </View>
    </Centered>
  );
}

/** Territory and Balloon Pop: no rules or stage yet; a board with the darts pinned. */
export function PreviewStage({ width, height, accent, lastLabel, color }: { width: number; height: number; accent: string; lastLabel?: string; color: number }) {
  if (width <= 0 || height <= 0) return null;
  const size = Math.min(width, height) * 0.9;
  return (
    <Centered width={width} height={height}>
      <View style={{ position: 'absolute', opacity: 0.6 }}>
        <StageBoard size={size} accent={accent} highlight={lastLabel ? [lastLabel] : []} />
      </View>
      <AText variant="kicker" color={playerColor(color)} upper>
        Preview · demo scoring
      </AText>
      {lastLabel ? <Hero text={lastLabel} size={size * 0.28} accent={accent} /> : null}
    </Centered>
  );
}
