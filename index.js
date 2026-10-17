const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  AuditLogEvent,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js");

// ================= CONFIG =================
const TOKEN = process.env.DISCORD_TOKEN; // set as an environment variable
// Staff roles (protected by the mute lock). Anyone ranked ABOVE the highest of these
// roles is automatically a "high rank" and can use the commands.
const STAFF_ROLE_IDS = [
  "1513904127837736992",
  "1513904125748711505",
  "1513904128961548368",
  "1513904125086011402",
];
const MOVE_DELAY = 800; // ms between moves in /playaround
const DATA_FILE = "data.json";
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ---------- slash command definitions ----------
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show all commands and what they do"),
  new SlashCommandBuilder().setName("muteall").setDescription("Mute everyone in your VC (except ranks above the bot)"),
  new SlashCommandBuilder().setName("unmuteall").setDescription("Unmute everyone in your VC"),
  new SlashCommandBuilder()
    .setName("moveall")
    .setDescription("Move everyone in your VC to another VC")
    .addChannelOption((o) =>
      o.setName("channel").setDescription("Destination voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("jail")
    .setDescription("Stop a member from joining any VC")
    .addUserOption((o) => o.setName("user").setDescription("Member to jail").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unjail")
    .setDescription("Let a jailed member join VCs again")
    .addUserOption((o) => o.setName("user").setDescription("Member to free").setRequired(true)),
  new SlashCommandBuilder()
    .setName("playaround")
    .setDescription("Move a member through every VC, then disconnect them")
    .addUserOption((o) => o.setName("user").setDescription("Member to play around with").setRequired(true)),
  new SlashCommandBuilder()
    .setName("smute")
    .setDescription("Mute a staff member and lock it until a high rank removes it")
    .addUserOption((o) => o.setName("user").setDescription("Staff member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("sunmute")
    .setDescription("Remove the mute lock and unmute a staff member")
    .addUserOption((o) => o.setName("user").setDescription("Staff member").setRequired(true)),
].map((c) => c.toJSON());

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands); // guild commands update instantly
  } catch (e) {
    console.error(`Failed to register commands in ${guild.name}:`, e.message);
  }
}

// ---------- storage ----------
let data = { jailed: {}, locked: {} };
if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data));
const bucket = (kind, guildId) => (data[kind][guildId] ??= []);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// High rank = Administrator, or a top role positioned above every staff role
const isHigh = (m) => {
  if (m.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const staffRoles = STAFF_ROLE_IDS.map((id) => m.guild.roles.cache.get(id)).filter(Boolean);
  if (!staffRoles.length) return false;
  const highestStaff = Math.max(...staffRoles.map((r) => r.position));
  return m.roles.highest.position > highestStaff;
};

// Staff = has a staff role and is not a high rank
const isStaff = (m) => !isHigh(m) && m.roles.cache.some((r) => STAFF_ROLE_IDS.includes(r.id));

// true if member's top role is higher than the bot's (or they own the server)
const aboveBot = (m) =>
  m.id === m.guild.ownerId ||
  m.roles.highest.comparePositionTo(m.guild.members.me.roles.highest) > 0;

// find who recently muted/unmuted this member via the audit log
async function findExecutor(member, muted) {
  await sleep(1000);
  try {
    const logs = await member.guild.fetchAuditLogs({
      type: AuditLogEvent.MemberUpdate,
      limit: 10,
    });
    const entry = logs.entries.find(
      (e) =>
        e.targetId === member.id &&
        Date.now() - e.createdTimestamp < 10000 &&
        e.changes.some((c) => c.key === "mute" && c.new === muted)
    );
    if (!entry) return null;
    return await member.guild.members.fetch(entry.executorId).catch(() => null);
  } catch {
    return null; // missing View Audit Log permission
  }
}

// ---------- events ----------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});

client.on("guildCreate", registerCommands);

client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;
  const gid = newState.guild.id;

  // JAIL: disconnect from any VC they try to join
  if (newState.channelId && bucket("jailed", gid).includes(member.id)) {
    await newState.disconnect("Jailed").catch(() => {});
    return;
  }

  const locked = bucket("locked", gid);

  // Auto-lock: a high rank server-muted a staff member
  if (newState.serverMute && !oldState.serverMute && isStaff(member) && !locked.includes(member.id)) {
    const executor = await findExecutor(member, true);
    if (executor && executor.id !== client.user.id && isHigh(executor)) {
      locked.push(member.id);
      save();
    }
  }
  // Locked staff got unmuted (or rejoined unmuted): only a high rank may release
  else if (locked.includes(member.id) && newState.channelId && !newState.serverMute) {
    const executor = await findExecutor(member, false);
    if (executor && executor.id !== client.user.id && isHigh(executor)) {
      locked.splice(locked.indexOf(member.id), 1);
      save();
    } else {
      await member.voice.setMute(true, "Staff mute lock").catch(() => {});
    }
  }
});

// ---------- slash command handler ----------
const playing = new Set();

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  // /help is open to everyone and only visible to the person who used it
  if (interaction.commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("Bot Commands")
      .setDescription("All commands except `/help` are for high ranks only.")
      .setColor(0x5865f2)
      .addFields(
        { name: "/muteall", value: "Mutes everyone in your VC except bots, you, and ranks above the bot." },
        { name: "/unmuteall", value: "Unmutes everyone in your VC. Staff under a mute lock stay muted." },
        { name: "/moveall channel:", value: "Moves everyone in your VC to the voice channel you pick." },
        { name: "/jail user:", value: "Disconnects the member and stops them from joining any VC." },
        { name: "/unjail user:", value: "Lets a jailed member join VCs again." },
        { name: "/playaround user:", value: "Moves the member through every VC, then disconnects them from the last one." },
        { name: "/smute user:", value: "Mutes a staff member and locks it. They can't unmute until a high rank removes it." },
        { name: "/sunmute user:", value: "Removes the mute lock and unmutes the staff member." },
        { name: "/help", value: "Shows this list." }
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (!isHigh(interaction.member)) {
    return interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply(); // gives us more than 3 seconds
  const reply = (content) => interaction.editReply(content);

  const guild = interaction.guild;
  const myVC = interaction.member.voice.channel;
  const target = interaction.options.getMember("user");
  const needsTarget = ["jail", "unjail", "playaround", "smute", "sunmute"];

  try {
    if (needsTarget.includes(interaction.commandName) && !target)
      return reply("That user isn't in this server.");

    switch (interaction.commandName) {
      case "muteall": {
        if (!myVC) return reply("Join a voice channel first.");
        let count = 0;
        for (const m of myVC.members.values()) {
          if (m.user.bot || m.id === interaction.user.id || aboveBot(m)) continue;
          await m.voice.setMute(true, `muteall by ${interaction.user.tag}`).then(() => count++).catch(() => {});
        }
        return reply(`Muted ${count} member(s).`);
      }

      case "unmuteall": {
        if (!myVC) return reply("Join a voice channel first.");
        const locked = bucket("locked", guild.id);
        let count = 0;
        for (const m of myVC.members.values()) {
          if (m.user.bot || locked.includes(m.id)) continue; // locked staff stay muted
          await m.voice.setMute(false, `unmuteall by ${interaction.user.tag}`).then(() => count++).catch(() => {});
        }
        return reply(`Unmuted ${count} member(s).`);
      }

      case "moveall": {
        if (!myVC) return reply("Join a voice channel first.");
        const dest = interaction.options.getChannel("channel");
        let count = 0;
        for (const m of [...myVC.members.values()]) {
          await m.voice.setChannel(dest).then(() => count++).catch(() => {});
        }
        return reply(`Moved ${count} member(s) to ${dest}.`);
      }

      case "jail": {
        if (target.user.bot || aboveBot(target)) return reply("I can't jail that member.");
        const jailed = bucket("jailed", guild.id);
        if (!jailed.includes(target.id)) {
          jailed.push(target.id);
          save();
        }
        if (target.voice.channel) await target.voice.disconnect("Jailed").catch(() => {});
        return reply(`${target} is jailed and can't join any VC.`);
      }

      case "unjail": {
        const jailed = bucket("jailed", guild.id);
        if (jailed.includes(target.id)) {
          jailed.splice(jailed.indexOf(target.id), 1);
          save();
        }
        return reply(`${target} is free to join VCs again.`);
      }

      case "playaround": {
        if (!target.voice.channel) return reply("That member isn't in a voice channel.");
        if (aboveBot(target) || playing.has(target.id))
          return reply("I can't do that to this member right now.");

        const me = guild.members.me;
        const channels = guild.channels.cache
          .filter(
            (c) =>
              c.type === ChannelType.GuildVoice &&
              c.permissionsFor(me).has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.MoveMembers,
              ])
          )
          .sort((a, b) => a.rawPosition - b.rawPosition);
        if (!channels.size) return reply("I have no voice channels I can move people into.");

        playing.add(target.id);
        await reply(`Taking ${target} on a tour of ${channels.size} channels...`);
        try {
          for (const ch of channels.values()) {
            if (!target.voice.channel) return; // they left on their own
            await target.voice.setChannel(ch);
            await sleep(MOVE_DELAY);
          }
          if (target.voice.channel) await target.voice.disconnect("playaround finished");
          await reply(`Finished playing around with ${target}.`);
        } catch {
          await reply("Something went wrong while moving them.");
        } finally {
          playing.delete(target.id);
        }
        return;
      }

      case "smute": {
        const locked = bucket("locked", guild.id);
        if (!locked.includes(target.id)) {
          locked.push(target.id);
          save();
        }
        if (target.voice.channel) await target.voice.setMute(true, `Locked mute by ${interaction.user.tag}`);
        return reply(`${target} is muted and locked.`);
      }

      case "sunmute": {
        const locked = bucket("locked", guild.id);
        if (locked.includes(target.id)) {
          locked.splice(locked.indexOf(target.id), 1);
          save();
        }
        if (target.voice.channel) await target.voice.setMute(false, `Lock removed by ${interaction.user.tag}`);
        return reply(`${target} is unlocked and unmuted.`);
      }
    }
  } catch (err) {
    console.error(err);
    reply("Something went wrong running that command.").catch(() => {});
  }
});

client.login(TOKEN);
