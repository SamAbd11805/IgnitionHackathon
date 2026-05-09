/* MayorChatPanel.jsx
 * Chat panel: an "AI Mayor" that observes the running crime simulation
 * and can adjust parameters via tool-use against the local Claude proxy.
 *
 * Wire-up:
 *   1. Local proxy must be running:  npm run claude-proxy
 *   2. The simulation entity must exist (#crime-sim-root) — start the sim
 *      from the Crime tab first.
 *   3. The Mayor talks to /api/claude on PROXY_URL; the agentic loop runs
 *      here in the browser so tools execute against the live A-Frame scene.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const PROXY_URL = 'http://localhost:3334/api/claude';
const SIM_ENTITY_ID = 'crime-sim-root';

// ── system prompt — defines the Mayor persona ───────────────────────────────
const SYSTEM_PROMPT = `You are the "AI Mayor" of a small simulated city visible to the user as a 3D scene.

The user is the Mayor's chief of staff and is asking you to monitor crime, recommend tactics, and act on the simulation directly.

You have tools that read live state and change simulation parameters in real time. When the user asks about the city, ALWAYS call get_city_state first instead of guessing — the data changes every second.

Style:
- Be concise: 2–4 sentences for status reports, longer only when explaining strategy.
- Lead with the data, then the recommendation.
- When you change a parameter, briefly explain WHY in the same response.
- If the simulation isn't running yet, tell the user to press "Start Simulation" in the Crime tab first.`;

// ── tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_city_state',
    description:
      'Returns the current state of the simulated city: total/resolved/pending crime counts, average police response time in ms, current simulation parameters, agent state breakdown (citizens wandering/fleeing/dead/arrested, police patrolling/responding/at_scene), and the locations + age of unresolved crimes.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_crime_rate',
    description:
      'Adjusts the per-second crime probability for each citizen. Range: 0.001 (very rare, ~1 crime/min) to 0.05 (chaos, several crimes/sec). Affects future crimes; does not retroactively change pending crimes.',
    input_schema: {
      type: 'object',
      properties: {
        rate: {
          type: 'number',
          description: 'Per-second per-citizen probability, 0.001 to 0.05'
        }
      },
      required: ['rate']
    }
  },
  {
    name: 'set_police_speed',
    description:
      'Adjusts the patrol/response speed of all police cars. Range: 2 (slow walk) to 20 (very fast). Higher = faster response time to crime scenes.',
    input_schema: {
      type: 'object',
      properties: {
        speed: {
          type: 'number',
          description: 'Speed in units per second, 2 to 20'
        }
      },
      required: ['speed']
    }
  },
  {
    name: 'force_crime',
    description:
      'Immediately triggers a random homicide event for demonstration purposes. Use sparingly — usually for "show me what a crime looks like" requests.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_paused',
    description: 'Pauses or resumes the simulation tick.',
    input_schema: {
      type: 'object',
      properties: { paused: { type: 'boolean' } },
      required: ['paused']
    }
  }
];

// ── client-side tool execution against the live A-Frame scene ────────────────
function getSim() {
  const el = document.getElementById(SIM_ENTITY_ID);
  return el && el.components && el.components['city-simulation'];
}

function executeTool(name, input) {
  const sim = getSim();
  if (!sim) {
    return {
      error:
        "Simulation is not currently running. Please ask the user to click 'Start Simulation' in the Crime tab."
    };
  }

  try {
    switch (name) {
      case 'get_city_state': {
        const countByState = (arr, s) =>
          arr.filter((a) => a.state === s).length;
        return {
          stats: {
            total_crimes: sim.stats.total,
            resolved: sim.stats.resolved,
            pending: sim.pendingCrimes.length,
            avg_response_ms: Math.round(sim.stats.avgResponseMs)
          },
          parameters: {
            crime_rate: sim.data.crimeRate,
            police_speed: sim.data.policeSpeed,
            police_count: sim.data.policeCount,
            citizen_count: sim.data.citizenCount,
            paused: !!sim.data.paused
          },
          citizens: {
            wandering: countByState(sim.citizens, 'wandering'),
            fleeing: countByState(sim.citizens, 'fleeing'),
            dead: countByState(sim.citizens, 'dead'),
            arrested: countByState(sim.citizens, 'arrested')
          },
          police: {
            patrolling: countByState(sim.police, 'patrolling'),
            responding: countByState(sim.police, 'responding'),
            at_scene: countByState(sim.police, 'at_scene')
          },
          unresolved_crimes: sim.pendingCrimes.slice(-5).map((c) => ({
            x: Number(c.x.toFixed(1)),
            z: Number(c.z.toFixed(1)),
            age_seconds: Math.round((Date.now() - c.ts) / 1000)
          }))
        };
      }
      case 'set_crime_rate': {
        const r = Math.max(0, Math.min(0.05, Number(input.rate)));
        sim.data.crimeRate = r;
        sim.citizens.forEach((c) => {
          c.data.crimeRate = r;
        });
        return { ok: true, new_crime_rate: r };
      }
      case 'set_police_speed': {
        const s = Math.max(1, Math.min(30, Number(input.speed)));
        sim.data.policeSpeed = s;
        sim.police.forEach((p) => {
          p.data.speed = s;
        });
        return { ok: true, new_police_speed: s };
      }
      case 'force_crime': {
        const wanderers = sim.citizens.filter((c) => c.state === 'wandering');
        if (wanderers.length < 2) {
          return { error: 'Not enough wandering citizens to commit a crime.' };
        }
        sim.attemptCrime(
          wanderers[Math.floor(Math.random() * wanderers.length)]
        );
        return { ok: true, message: 'Crime triggered.' };
      }
      case 'set_paused': {
        const el = document.getElementById(SIM_ENTITY_ID);
        if (!el) {
          return { error: 'Simulation entity not found.' };
        }
        const p = !!input.paused;
        el.setAttribute('city-simulation', 'paused', p);
        return { ok: true, paused: p };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

// ── helpers to render the assistant content ─────────────────────────────────
function getAssistantText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function getToolCalls(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((b) => b.type === 'tool_use');
}

// ── main panel ──────────────────────────────────────────────────────────────
export default function MayorChatPanel() {
  const [conversation, setConversation] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [proxyOk, setProxyOk] = useState(null); // null=unknown, true=up, false=down
  const scrollRef = useRef(null);

  // Health-check the proxy on mount
  useEffect(() => {
    let cancelled = false;
    fetch('http://localhost:3334/health', { method: 'GET' })
      .then((r) => r.json())
      .then(() => {
        if (!cancelled) {
          setProxyOk(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProxyOk(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation, loading]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) {
      return;
    }
    setInput('');
    setLoading(true);

    // Build the conversation locally for the agentic loop
    let conv = [...conversation, { role: 'user', content: text }];
    setConversation(conv);

    try {
      // Agentic loop: keep calling Claude until stop_reason === 'end_turn'.
      // Tool calls execute client-side against the live scene.
      // Hard cap iterations to avoid runaway loops.
      for (let i = 0; i < 8; i++) {
        const resp = await fetch(PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: conv,
            system: SYSTEM_PROMPT,
            tools: TOOLS
          })
        });
        const data = await resp.json();
        if (data.error) {
          conv = [
            ...conv,
            {
              role: 'assistant',
              content: `⚠ API error: ${data.error}`
            }
          ];
          setConversation(conv);
          break;
        }

        // Append assistant turn (preserve full content blocks for tool_use)
        conv = [...conv, { role: 'assistant', content: data.content }];
        setConversation(conv);

        if (
          data.stop_reason === 'end_turn' ||
          data.stop_reason === 'stop_sequence'
        ) {
          break;
        }

        // Execute every tool_use block, then send results back
        const toolUses = getToolCalls(data.content);
        if (toolUses.length === 0) {
          break;
        }

        const toolResults = toolUses.map((tu) => {
          const result = executeTool(tu.name, tu.input);
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result)
          };
        });

        conv = [...conv, { role: 'user', content: toolResults }];
        setConversation(conv);
      }
    } catch (err) {
      conv = [
        ...conv,
        {
          role: 'assistant',
          content: `⚠ Network error: ${err.message}. Is the proxy running? \`npm run claude-proxy\``
        }
      ];
      setConversation(conv);
    }

    setLoading(false);
  }, [input, loading, conversation]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── styles ────────────────────────────────────────────────────────────────
  const card = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(100,160,255,0.15)',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 10
  };

  const msgUser = {
    background: 'rgba(126, 207, 255, 0.12)',
    border: '1px solid rgba(126, 207, 255, 0.3)',
    color: '#dde9ff',
    borderRadius: 8,
    padding: '8px 10px',
    margin: '6px 0',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  };

  const msgAssistant = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#e8e8f0',
    borderRadius: 8,
    padding: '8px 10px',
    margin: '6px 0',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  };

  const msgTool = {
    background: 'rgba(255, 200, 71, 0.08)',
    color: '#a89060',
    borderLeft: '2px solid rgba(255, 200, 71, 0.4)',
    padding: '4px 8px',
    margin: '4px 0',
    fontSize: 10,
    fontStyle: 'italic'
  };

  return (
    <div
      style={{
        padding: '12px 14px',
        color: '#c8deff',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 10, flex: '0 0 auto' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: '#7ecfff',
            letterSpacing: 1,
            textTransform: 'uppercase'
          }}
        >
          🏛 AI Mayor
        </div>
        <div style={{ fontSize: 11, color: '#556', marginTop: 3 }}>
          Powered by llama-3.3-70b on Groq — observes & controls the simulation
        </div>
      </div>

      {/* Proxy status */}
      {proxyOk === false && (
        <div
          style={{
            ...card,
            borderColor: 'rgba(255,80,80,0.4)',
            background: 'rgba(120,20,20,0.2)',
            color: '#ffaaaa',
            fontSize: 11
          }}
        >
          ⚠ Local proxy not detected on port 3334.
          <br />
          Run in a separate terminal:
          <pre
            style={{
              margin: '6px 0 0',
              padding: 6,
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 4,
              fontSize: 10,
              color: '#7ecfff'
            }}
          >
            npm run claude-proxy
          </pre>
        </div>
      )}

      {/* Conversation */}
      <div
        ref={scrollRef}
        style={{
          ...card,
          flex: '1 1 auto',
          overflowY: 'auto',
          minHeight: 100
        }}
      >
        {conversation.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: '#556',
              fontStyle: 'italic',
              padding: '8px 0'
            }}
          >
            Try asking:
            <br />• &quot;What&apos;s happening in the city?&quot;
            <br />• &quot;Why is the response time so high?&quot;
            <br />• &quot;Increase the crime rate to test the police&quot;
            <br />• &quot;Pause the simulation&quot;
          </div>
        )}

        {conversation.map((msg, i) => {
          if (msg.role === 'user') {
            const text =
              typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter((b) => b.type === 'tool_result')
                      .map((b) => `→ tool result: ${b.content.slice(0, 60)}…`)
                      .join('\n')
                  : '';
            // Hide tool_result echoes from the chat — they're noisy
            if (
              Array.isArray(msg.content) &&
              msg.content.every((b) => b.type === 'tool_result')
            ) {
              return null;
            }
            return (
              <div key={i} style={msgUser}>
                {text}
              </div>
            );
          }
          // assistant
          const text = getAssistantText(msg.content);
          const tools = getToolCalls(msg.content);
          return (
            <div key={i}>
              {tools.map((t, j) => (
                <div key={`t${j}`} style={msgTool}>
                  ⚙ called <b>{t.name}</b>
                  {t.input && Object.keys(t.input).length > 0
                    ? `(${JSON.stringify(t.input)})`
                    : '()'}
                </div>
              ))}
              {text && <div style={msgAssistant}>{text}</div>}
            </div>
          );
        })}

        {loading && (
          <div
            style={{ ...msgAssistant, color: '#7ecfff', fontStyle: 'italic' }}
          >
            thinking…
          </div>
        )}
      </div>

      {/* Input */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          gap: 6,
          marginTop: 6
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask the AI Mayor…"
          style={{
            flex: 1,
            background: 'rgba(0,0,0,0.4)',
            color: '#fff',
            border: '1px solid rgba(100,160,255,0.3)',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 12,
            fontFamily: 'inherit',
            resize: 'none'
          }}
          disabled={loading || proxyOk === false}
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim() || proxyOk === false}
          style={{
            background: '#1a5a8a',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '0 14px',
            fontSize: 12,
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading || !input.trim() || proxyOk === false ? 0.5 : 1
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
