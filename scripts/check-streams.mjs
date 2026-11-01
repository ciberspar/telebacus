import fs from "node:fs/promises";

const CHANNELS_URL =
  "https://iptv-org.github.io/api/channels.json";

const STREAMS_URL =
  "https://iptv-org.github.io/api/streams.json";

const OUTPUT = "docs/health.json";

const CONCURRENCY = 20;
const TIMEOUT = 8000;

const USER_AGENT = "TeleBacus-Global-Checker/4.0";

function isAllowedChannel(channel) {
  const categories = Array.isArray(channel.categories)
    ? channel.categories.join(" ").toLowerCase()
    : "";

  const name = String(channel.name || "").toLowerCase();

  const blocked = ["xxx", "porn", "adult", "erotic"];

  if (channel.is_nsfw === true || channel.isNsfw === true) {
    return false;
  }

  if (blocked.some(word => categories.includes(word))) {
    return false;
  }

  if (blocked.some(word => name.includes(word))) {
    return false;
  }

  return Boolean(channel.id && channel.name);
}

async function downloadJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(
      `Error HTTP ${response.status}: ${url}`
    );
  }

  return response.json();
}

async function checkStream(url) {
  try {
    const parsed = new URL(url);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        status: "offline",
        reason: "Protocolo no permitido"
      };
    }

    const response = await fetch(parsed, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        "Range": "bytes=0-0",
        "User-Agent": USER_AGENT
      }
    });

    const contentType =
      (response.headers.get("content-type") || "").toLowerCase();

    const validStatus =
      response.status >= 200 && response.status < 300;

    const validContent =
      !contentType.includes("text/html");

    const online = validStatus && validContent;

    try {
      await response.body?.cancel();
    } catch {
      // La respuesta puede haberse cerrado.
    }

    return {
      status: online ? "online" : "offline",
      http: response.status,
      contentType
    };

  } catch (error) {
    return {
      status: "offline",
      reason:
        error.name === "TimeoutError"
          ? "Timeout"
          : "No se pudo conectar"
    };
  }
}

async function runPool(items, worker, concurrency) {
  let next = 0;

  const workers = Array.from(
    {
      length: Math.min(concurrency, items.length)
    },
    async () => {
      while (true) {
        const index = next++;

        if (index >= items.length) {
          return;
        }

        await worker(items[index], index);
      }
    }
  );

  await Promise.all(workers);
}

async function main() {
  console.log("================================");
  console.log(" TELEBACUS GLOBAL STREAM CHECK");
  console.log("================================");

  console.log("Descargando catálogo mundial...");

  const [allChannels, allStreams] = await Promise.all([
    downloadJSON(CHANNELS_URL),
    downloadJSON(STREAMS_URL)
  ]);

  const channels = allChannels.filter(isAllowedChannel);

  const validIds = new Set(
    channels.map(channel => channel.id)
  );

  const streams = allStreams.filter(stream => {
    if (!stream || !validIds.has(stream.channel)) {
      return false;
    }

    if (typeof stream.url !== "string") {
      return false;
    }

    try {
      const url = new URL(stream.url);

      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  });

  const grouped = new Map();

  for (const stream of streams) {
    if (!grouped.has(stream.channel)) {
      grouped.set(stream.channel, []);
    }

    grouped.get(stream.channel).push(stream);
  }

  const jobs = [];

  for (const [channelId, sources] of grouped) {
    for (const source of sources) {
      jobs.push({
        channelId,
        url: source.url
      });
    }
  }

  console.log(`Canales encontrados: ${channels.length}`);
  console.log(`Fuentes encontradas: ${jobs.length}`);
  console.log("Comprobando transmisiones...");

  const results = new Map();

  let completed = 0;

  await runPool(
    jobs,
    async job => {
      const result = await checkStream(job.url);

      if (!results.has(job.channelId)) {
        results.set(job.channelId, []);
      }

      results.get(job.channelId).push({
        url: job.url,
        ...result
      });

      completed++;

      if (completed % 100 === 0 || completed === jobs.length) {
        console.log(
          `Progreso: ${completed}/${jobs.length}`
        );
      }
    },
    CONCURRENCY
  );

  const output = {
    version: 1,
    checkedAt: new Date().toISOString(),
    totalChannels: channels.length,
    totalSources: jobs.length,
    onlineChannels: 0,
    offlineChannels: 0,
    unknownChannels: 0,
    channels: {}
  };

  for (const channel of channels) {
    const sources = results.get(channel.id) || [];

    const onlineCount = sources.filter(
      source => source.status === "online"
    ).length;

    let status = "unknown";

    if (onlineCount > 0) {
      status = "online";
      output.onlineChannels++;
    } else if (sources.length > 0) {
      status = "offline";
      output.offlineChannels++;
    } else {
      output.unknownChannels++;
    }

    output.channels[channel.id] = {
      name: channel.name,
      country: channel.country || null,
      status,
      onlineSources: onlineCount,
      totalSources: sources.length,
      sources
    };
  }

  await fs.mkdir("docs", {
    recursive: true
  });

  await fs.writeFile(
    OUTPUT,
    JSON.stringify(output, null, 2) + "\n",
    "utf8"
  );

  console.log("");
  console.log("================================");
  console.log(" RESULTADO DE TELEBACUS");
  console.log("================================");
  console.log(`Canales: ${output.totalChannels}`);
  console.log(`Fuentes: ${output.totalSources}`);
  console.log(`Online: ${output.onlineChannels}`);
  console.log(`Offline: ${output.offlineChannels}`);
  console.log(`Sin fuentes: ${output.unknownChannels}`);
  console.log("");
  console.log(`Archivo generado: ${OUTPUT}`);
  console.log("Verificación finalizada.");
}

main().catch(error => {
  console.error("ERROR EN TELEBACUS:", error);
  process.exit(1);
});