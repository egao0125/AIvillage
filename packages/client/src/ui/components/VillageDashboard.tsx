import React from 'react';
import { useBoard, useElections, useProperties, useInstitutions, useAgents, useWeather, useWorldTime } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';

const sectionLabel: React.CSSProperties = {
  color: COLORS.textAccent,
  marginBottom: 8,
  marginTop: 16,
  fontSize: '9px',
  fontFamily: FONTS.pixel,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const TYPE_STYLES: Record<string, { icon: string; color: string }> = {
  decree: { icon: '\u{1F451}', color: '#ff6b6b' },
  rule: { icon: '\u{2696}', color: '#fbbf24' },
  announcement: { icon: '\u{1F4E2}', color: '#60a5fa' },
  alliance: { icon: '\u{1F91D}', color: '#4ade80' },
};

export const VillageDashboard: React.FC = () => {
  const board = useBoard();
  const elections = useElections();
  const properties = useProperties();
  const institutions = useInstitutions();
  const agents = useAgents();
  const weather = useWeather();
  const time = useWorldTime();

  const aliveAgents = agents.filter(a => a.alive !== false);

  const rules = board.filter(p => (p.type === 'decree' || p.type === 'rule') && !p.revoked);
  const alliances = board.filter(p => p.type === 'alliance' && !p.revoked);
  const announcements = board.filter(p => p.type === 'announcement' && !p.revoked);

  const activeElections = elections.filter(e => e.active);
  const pastElections = elections.filter(e => !e.active && e.winner);

  const activeInstitutions = institutions.filter(i => !i.dissolved);

  return (
    <div style={{ padding: 12, fontFamily: FONTS.body, fontSize: '13px', color: COLORS.text }}>
      {/* Village Status */}
      <div style={sectionLabel}>VILLAGE STATUS</div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 6,
        marginBottom: 4,
      }}>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Population</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{aliveAgents.length} agents</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Day / Season</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>Day {time.day}, {weather.season}</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Weather</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{weather.current} ({weather.temperature}°)</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Time</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{time.hour}:{String(time.minute).padStart(2, '0')}</div>
        </div>
      </div>

      {/* Active Rules & Decrees */}
      {rules.length > 0 && (
        <>
          <div style={sectionLabel}>RULES & DECREES ({rules.length})</div>
          {[...rules].reverse().map(post => {
            const s = TYPE_STYLES[post.type] || TYPE_STYLES.announcement;
            return (
              <div key={post.id} style={{
                marginBottom: 6,
                padding: '8px 10px',
                background: COLORS.bgCard,
                borderRadius: 4,
                borderLeft: `3px solid ${s.color}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: '10px' }}>{s.icon}</span>
                  <span style={{ color: s.color, textTransform: 'uppercase', fontSize: '9px', fontFamily: FONTS.pixel, letterSpacing: 1 }}>{post.type}</span>
                  <span style={{ color: COLORS.textDim, fontSize: '11px' }}>by {post.authorName}</span>
                </div>
                <div style={{ color: COLORS.text, lineHeight: '1.5' }}>{post.content}</div>
                <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 3 }}>Day {post.day}</div>
              </div>
            );
          })}
        </>
      )}

      {/* Elections */}
      {(activeElections.length > 0 || pastElections.length > 0) && (
        <>
          <div style={sectionLabel}>ELECTIONS</div>
          {activeElections.map(election => {
            const counts: Record<string, number> = {};
            for (const c of election.candidates) counts[c] = 0;
            for (const v of Object.values(election.votes) as string[]) counts[v] = (counts[v] || 0) + 1;
            const daysLeft = election.endDay - time.day;

            return (
              <div key={election.id} style={{
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 10,
                marginBottom: 6,
              }}>
                <div style={{ color: '#fff', fontSize: '11px', marginBottom: 4, fontFamily: FONTS.pixel }}>
                  {'\u{1F5F3}\u{FE0F}'} {election.position}
                </div>
                {election.candidates.map((c: string) => {
                  const candidateAgent = agents.find(a => a.id === c);
                  return (
                    <div key={c} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: COLORS.text }}>
                      <span>{candidateAgent?.config.name ?? c.slice(0, 8)}</span>
                      <span style={{ color: COLORS.textDim }}>{counts[c] || 0} vote{(counts[c] || 0) !== 1 ? 's' : ''}</span>
                    </div>
                  );
                })}
                <div style={{ color: COLORS.idle, marginTop: 4, fontSize: '11px' }}>
                  {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining` : 'Ending soon'}
                </div>
              </div>
            );
          })}
          {pastElections.slice(-3).reverse().map(e => {
            const winner = agents.find(a => a.id === e.winner);
            return (
              <div key={e.id} style={{
                padding: '6px 10px',
                marginBottom: 4,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
                opacity: 0.7,
              }}>
                <span style={{ color: COLORS.textDim, fontSize: '11px' }}>{e.position}: </span>
                <span style={{ color: COLORS.active, fontSize: '11px' }}>{winner?.config.name ?? 'unknown'} won</span>
              </div>
            );
          })}
        </>
      )}

      {/* Properties */}
      {properties.length > 0 && (
        <>
          <div style={sectionLabel}>PROPERTIES ({properties.length})</div>
          {properties.map(p => {
            const owner = agents.find(a => a.id === p.ownerId);
            return (
              <div key={p.areaId} style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}>
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{p.areaId}</span>
                <span style={{ color: COLORS.textDim, fontSize: '12px' }}>{owner?.config.name ?? p.ownerId.slice(0, 8)}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Alliances */}
      {alliances.length > 0 && (
        <>
          <div style={sectionLabel}>ALLIANCES ({alliances.length})</div>
          {[...alliances].reverse().map(post => (
            <div key={post.id} style={{
              padding: '8px 10px',
              marginBottom: 4,
              background: COLORS.bgCard,
              borderRadius: 4,
              borderLeft: '3px solid #4ade80',
            }}>
              <div style={{ color: COLORS.text, lineHeight: '1.5' }}>{post.content}</div>
              <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 3 }}>by {post.authorName} — Day {post.day}</div>
            </div>
          ))}
        </>
      )}

      {/* Institutions */}
      {activeInstitutions.length > 0 && (
        <>
          <div style={sectionLabel}>INSTITUTIONS ({activeInstitutions.length})</div>
          {activeInstitutions.map(inst => (
            <div key={inst.id} style={{
              padding: '8px 10px',
              marginBottom: 6,
              background: COLORS.bgCard,
              borderRadius: 4,
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: COLORS.text, fontSize: '12px', fontWeight: 'bold' }}>{inst.name}</span>
                <span style={{ color: COLORS.textDim, fontSize: '10px' }}>{inst.type}</span>
              </div>
              {inst.description && (
                <div style={{ color: COLORS.textDim, fontSize: '11px', marginBottom: 4, lineHeight: '1.4' }}>{inst.description}</div>
              )}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {inst.members.map(m => {
                  const member = agents.find(a => a.id === m.agentId);
                  return (
                    <span key={m.agentId} style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: m.role === 'founder' ? COLORS.accent + '30' : COLORS.border,
                      color: m.role === 'founder' ? COLORS.accent : COLORS.textDim,
                    }}>
                      {member?.config.name ?? m.agentId.slice(0, 8)} ({m.role})
                    </span>
                  );
                })}
              </div>
              {inst.treasury > 0 && (
                <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 4 }}>Has treasury</div>
              )}
            </div>
          ))}
        </>
      )}

      {/* Announcements */}
      {announcements.length > 0 && (
        <>
          <div style={sectionLabel}>ANNOUNCEMENTS ({announcements.length})</div>
          {[...announcements].reverse().slice(0, 10).map(post => (
            <div key={post.id} style={{
              padding: '8px 10px',
              marginBottom: 4,
              background: COLORS.bgCard,
              borderRadius: 4,
              borderLeft: '3px solid #60a5fa',
            }}>
              <div style={{ color: COLORS.text, lineHeight: '1.5' }}>{post.content}</div>
              <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 3 }}>by {post.authorName} — Day {post.day}</div>
            </div>
          ))}
        </>
      )}

      {/* Empty state */}
      {rules.length === 0 && activeElections.length === 0 && pastElections.length === 0 && properties.length === 0 && alliances.length === 0 && activeInstitutions.length === 0 && announcements.length === 0 && (
        <div style={{ textAlign: 'center', color: COLORS.textDim, padding: '24px 12px' }}>
          The village has no official records yet.
          <br />
          <span style={{ fontSize: '11px', marginTop: 8, display: 'block' }}>
            Agents will post decrees, call elections, and form alliances here.
          </span>
        </div>
      )}
    </div>
  );
};
