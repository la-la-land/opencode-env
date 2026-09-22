/**
 * mock-ctx.mjs
 * Provides a mock context for testing the opencode plugin.
 */
export function mockCtx() {
  return {
    id: "mock-session-id",
    location: {
      directory: "/home/leonid/notix",
      project: { canonical: "/home/leonid/notix" }
    },
    session: {
      get: async (params) => ({
        directory: "/home/leonid/notix",
        id: params.sessionID
      }),
      hooks: new Map(),
      hook(name, fn) {
        this.hooks.set(name, fn);
        return {
          dispose: () => { this.hooks.delete(name); }
        };
      }
    },
    tool: {
      tools: [],
      namespace(config) {
        this.tools.push({ namespace: config.name, description: config.description });
      },
      add(config) {
        this.tools.push({ ...config, namespace: config.options?.namespace });
      },
      transform(callback) {
        callback(this);
        return { dispose: () => {} };
      }
    },
    event: {
      subscribe() {
        async function* generator() {
          yield { type: "session.idle", properties: { sessionID: "mock-session-id" } };
          yield { type: "session.deleted", properties: { sessionID: "mock-session-id" } };
        }
        return generator();
      }
    },
    model: {
      default: () => Promise.resolve({ providerID: "OpenAI", modelID: "gpt-4o" })
    }
  };
}
