import express from "express";
import discord from "discord.js";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

dotenv.config({ override: true });

const app = express();
app.use(cookieParser());

const clientId = process.env.CLIENT_ID as string;
const clientSecret = process.env.CLIENT_SECRET as string;
const redirectUri = process.env.REDIRECT_URI as string;
const hostUrl = process.env.HOST_URL as string;
const port = parseInt(process.env.PORT as string);
const volumeName = process.env.VOLUME_NAME as string;
const scope =
  "user-read-private user-read-email user-read-recently-played playlist-modify-public playlist-modify-private";

const discordToken = process.env.DISCORD_TOKEN as string;

const discordClient = new discord.Client({
  intents: [
    "Guilds",
    "GuildMessages",
    "DirectMessages",
    "MessageContent",
    "GuildMembers",
    "GuildPresences",
  ],
  partials: [discord.Partials.Channel, discord.Partials.Message],
});

discordClient.once("ready", () => {
  console.log("Discord bot ready");
});

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isDMBased()) return;
  message.channel.send(
    `Hi! I'm Song A Day 2024, and my job is to make you a playlist that takes you back to your most listened songs of the year :)\nIf you're new, **I'll need access to your recent listening history, you can do that by clicking here:** ${hostUrl}/authorise?discord=${message.author.id}`
  );
});

discordClient.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;
  member.send(
    `Welcome to Song A Day 2024! My job is to make you a playlist that takes you back to your most listened songs of the year :)\n**I'll need access to your recent listening history, you can do that by clicking here:** ${hostUrl}/authorise?discord=${member.id}`
  );
});

discordClient.login(discordToken);

const oneDay = 1000 * 60 * 60 * 24;

function getDayOfYear(timestamp: number, year: number): number {
  const date = new Date(timestamp);
  const maxDate = new Date(year + 1, 0, 1);

  if (maxDate.getTime() <= date.getTime()) {
    return (
      Math.floor(
        (maxDate.getTime() - new Date(year, 0, 1).getTime()) / oneDay
      ) + 1
    );
  }

  return Math.floor((timestamp - new Date(year, 0, 1).getTime()) / oneDay) + 1;
}

function getDaysInYear(year: number): number {
  const maxDate = new Date(year + 1, 0, 1);

  return (
    Math.floor((maxDate.getTime() - new Date(year, 0, 1).getTime()) / oneDay) +
    1
  );
}

function getFirstListen(arr: { [key: string]: number }): number {
  let minIndex: number = Infinity;
  for (let [key, value] of Object.entries(arr)) {
    let index = parseInt(key);
    if (index < minIndex) {
      minIndex = index;
    }
  }
  return minIndex;
}

function getMaxIndex(arr: { [key: string]: number }): number | null {
  let max = null as number | null;
  let maxIndex: number[] = [];
  for (let [key, value] of Object.entries(arr)) {
    if (max === null || value > max) {
      max = value;
      maxIndex = [parseInt(key)];
    } else if (value === max) {
      maxIndex.push(parseInt(key));
    }
  }
  return maxIndex.length === 0
    ? null
    : maxIndex[Math.floor(maxIndex.length / 2)];
}

const oneMinute = 1000 * 60;

async function updateTracks(
  timeout: NodeJS.Timeout | null,
  accessToken: string,
  refreshToken: string,
  id: string,
  playlistId: string,
  discordId: string | null
) {
  let tracks: {
    playlist: string;
    discord: string | null;
    access: string;
    refresh: string;
    tracks: {
      [id: string]: {
        name?: string;
        total: number;
        daily: { [day: string]: number };
      };
    };
    lastUpdated: number;
  } = {
    playlist: playlistId,
    discord: discordId,
    access: accessToken,
    refresh: refreshToken,
    tracks: {},
    lastUpdated: 0,
  };

  await (function (): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.readFile(`${volumeName}/${id}.json`, "utf8", (err, data) => {
        if (err) {
          resolve();
        } else {
          tracks = JSON.parse(data);
          tracks.access = accessToken;
          tracks.refresh = refreshToken;
          resolve();
        }
      });
    });
  })();

  let boundaryPassed = false;
  let lastTime = 0;
  let next: string | null = null;

  const earliest = Date.parse("2024-01-01T00:00:00");
  const latest = Date.parse("2025-01-01T00:00:00");

  while (!boundaryPassed) {
    const url: string =
      next === null
        ? `https://api.spotify.com/v1/me/player/recently-played?limit=50`
        : next;
    const data = await axios
      .get(url, {
        headers: {
          Authorization: "Bearer " + accessToken,
        },
      })
      .then((response) => {
        const d = response.data as {
          items: {
            played_at: string;
            track: {
              uri: string;
              name: string;
            };
          }[];
          next: string | null;
        };
        return d;
      })
      .catch((error) => {
        console.error(`${id} Couldn't get recently played ${error}`);
        if (timeout !== null) clearInterval(timeout);

        if (discordId !== null)
          discordClient.users.fetch(discordId).then((user) => {
            user.send(
              `I couldn't seem to get your recently played tracks :( **Try authorising me again:** ${hostUrl}/authorise?discord=${discordId}`
            );
          });
        return null;
      });

    if (data === null) {
      boundaryPassed = true;
      return;
    }

    next = data.next;
    if (next === null) {
      boundaryPassed = true;
    }

    for (const item of data.items.reverse()) {
      const date = Date.parse(item.played_at);

      if (date > lastTime) {
        lastTime = date;
      }

      if (date >= latest) {
        continue;
      }
      if (date < earliest) {
        continue;
      }
      if (date <= tracks.lastUpdated) {
        boundaryPassed = true;
        continue;
      }

      const uri = item.track.uri;

      let oldTrack = tracks.tracks[uri];
      if (oldTrack === undefined) {
        oldTrack = {
          name: item.track.name,
          total: 0,
          daily: {},
        };
      }
      oldTrack.total++;

      const day = getDayOfYear(date, 2024).toString();
      if (oldTrack.daily[day] === undefined) {
        oldTrack.daily[day] = 0;
      }
      oldTrack.daily[day]++;

      tracks.tracks[uri] = oldTrack;
    }
  }

  tracks.lastUpdated =
    tracks.lastUpdated > lastTime ? tracks.lastUpdated : lastTime;

  if (tracks.lastUpdated >= latest) {
    if (timeout !== null) clearInterval(timeout);

    if (discordId !== null)
      discordClient.users.fetch(discordId).then((user) => {
        user.send(
          `It's the end of Song A Day 2024 - happy new year!\nWatch the discord server for updates about Song A Day 2025 👀`
        );
      });

    tracks.lastUpdated = latest;
  }

  fs.writeFile(`${volumeName}/${id}.json`, JSON.stringify(tracks), (err) => {
    if (err) {
      console.error(`${id}: Couldn't write to file ${err}`);
    }
  });

  const nDays = getDayOfYear(Date.now(), 2024);
  const nDaysInYear = getDaysInYear(2024);

  const sortedTracks = Object.entries(tracks.tracks)
    .map(([uri, track]) => {
      let firstListen = getFirstListen(track.daily) - 1;
      if (firstListen == Infinity) {
        firstListen = 0;
      }
      return [
        uri,
        (nDaysInYear - firstListen) *
          (track.total / Math.max(nDays * 2 - firstListen, 1)),
        getMaxIndex(track.daily) ?? Infinity,
      ] as [string, number, number];
    })
    .sort(([, a], [, b]) => b - a)
    .slice(0, nDays)
    .sort(([, , a], [, , b]) => a - b);

  const trackUris = sortedTracks.map(([uri]) => uri);

  for (let i = 0; i < trackUris.length; i += 100) {
    const uris = trackUris.slice(i, i + 100);

    if (i === 0) {
      await axios
        .put(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          JSON.stringify({
            uris: uris,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + accessToken,
            },
          }
        )
        .then((response) => {})
        .catch((error) => {
          console.error(`${id}: Couldn't replace playlist ${error}`);
          if (timeout !== null) clearInterval(timeout);

          if (discordId !== null)
            discordClient.users.fetch(discordId).then((user) => {
              user.send(
                `I couldn't seem to add to your playlist :( **Try authorising me again:** ${hostUrl}/authorise?discord=${discordId}`
              );
            });
        });
    } else {
      await axios
        .post(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          JSON.stringify({
            uris: uris,
            position: i,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + accessToken,
            },
          }
        )
        .then((response) => {})
        .catch((error) => {
          console.error(`${id}: Couldn't add to playlist ${error}`);
          if (timeout !== null) clearInterval(timeout);

          if (discordId !== null)
            discordClient.users.fetch(discordId).then((user) => {
              user.send(
                `I couldn't seem to add to your playlist :( **Try authorising me again:** ${hostUrl}/authorise?discord=${discordId}`
              );
            });
        });
    }
  }
  console.log(`Scrobbled ${id}`);

  return;
}

async function scrobble(
  id: string,
  playlistId: string,
  discordId: string | null,
  accessToken: string,
  refreshToken: string,
  res: express.Response | null
) {
  axios
    .post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        refresh_token: refreshToken ?? "",
        redirect_uri: redirectUri,
        grant_type: "refresh_token",
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            new (Buffer as any).from(clientId + ":" + clientSecret).toString(
              "base64"
            ),
        },
      }
    )
    .then(async (response) => {
      accessToken = response.data.access_token;
      refreshToken =
        response.data.refresh_token === undefined
          ? refreshToken
          : response.data.refresh_token;
      await updateTracks(
        timeout,
        accessToken,
        refreshToken,
        id,
        playlistId!,
        discordId
      );
    })
    .catch((error) => {
      console.error(`${id}: Authorisation error ${error}`);
      clearInterval(timeout);

      res?.status(401).send("Authorisation error");
      if (discordId !== null)
        discordClient.users.fetch(discordId).then((user) => {
          user.send(
            `Looks like there was an authorisation problem :( **Maybe try authorising again?** ${hostUrl}/authorise?discord=${discordId}`
          );
        });
    });

  let timeout = setInterval(() => {
    axios
      .post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          refresh_token: refreshToken ?? "",
          redirect_uri: redirectUri,
          grant_type: "refresh_token",
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " +
              new (Buffer as any).from(clientId + ":" + clientSecret).toString(
                "base64"
              ),
          },
        }
      )
      .then(async (response) => {
        accessToken = response.data.access_token;
        refreshToken =
          response.data.refresh_token === undefined
            ? refreshToken
            : response.data.refresh_token;
        await updateTracks(
          timeout,
          accessToken,
          refreshToken,
          id,
          playlistId!,
          discordId
        );
      })
      .catch((error) => {
        console.error(`${id}: Authorisation error ${error}`);
        clearInterval(timeout);

        res?.status(401).send("Authorisation error");
        if (discordId !== null)
          discordClient.users.fetch(discordId).then((user) => {
            user.send(
              `Looks like there was an authorisation problem :( **Maybe try authorising again?** ${hostUrl}/authorise?discord=${discordId}`
            );
          });
      });
  }, oneMinute * 15);
}

app.get("/callback", function (req, res) {
  let accessToken = req.query.code as string;

  const discordId: string | null = req.cookies?.discord_user_id;

  axios
    .post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        code: accessToken,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            new (Buffer as any).from(clientId + ":" + clientSecret).toString(
              "base64"
            ),
        },
      }
    )
    .then(async (response) => {
      accessToken = response.data.access_token;
      let refreshToken = response.data.refresh_token;

      const id = await axios
        .get(`https://api.spotify.com/v1/me`, {
          headers: {
            Authorization: "Bearer " + accessToken,
          },
        })
        .then((response) => {
          const d = response.data as {
            id: string;
          };
          return d.id;
        })
        .catch((error) => {
          console.error("Couldn't get user id", error);
          res.status(401).send("Couldn't get user id");

          if (discordId !== null)
            discordClient.users.fetch(discordId).then((user) => {
              user.send(
                `I couldn't find your Spotify id :( **Maybe try authorising again?** ${hostUrl}/authorise?discord=${discordId}`
              );
            });
          return null;
        });

      if (id === null) {
        return;
      }

      let playlistId: string | null = null;

      if (fs.existsSync(`${volumeName}/${id}.json`)) {
        await (function (): Promise<void> {
          return new Promise<void>((resolve, reject) => {
            fs.readFile(`${volumeName}/${id}.json`, "utf8", (err, data) => {
              if (err) {
                console.error(`${id}: Couldn't read file ${err}`);
                resolve();
              } else {
                playlistId = JSON.parse(data).playlist;
                resolve();
              }
            });
          });
        })();
      }

      if (playlistId === null) {
        playlistId = await axios
          .post(
            `https://api.spotify.com/v1/users/${id}/playlists`,
            JSON.stringify({
              name: "Song A Day 2024",
              description:
                "Generated by Song A Day 2024 - create your own here https://discord.gg/Xv374Urbdn",
            }),
            {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Bearer " + accessToken,
              },
            }
          )
          .then((response) => {
            const d = response.data as {
              id: string;
            };
            return d.id;
          })
          .catch((error) => {
            console.error(`${id}: Couldn't create playlist ${error}`);
            res.status(401).send("Couldn't create playlist");

            if (discordId !== null)
              discordClient.users.fetch(discordId).then((user) => {
                user.send(
                  `I couldn't create the playlist :( **Maybe try again?** ${hostUrl}/authorise?discord=${discordId}`
                );
              });
            return null;
          });
      }

      if (playlistId === null) {
        return;
      }

      scrobble(id, playlistId, discordId, accessToken, refreshToken, res);

      res.send("Successfully authorised");
      if (discordId !== null)
        discordClient.users.fetch(discordId).then((user) => {
          user.send("Thanks for authorising me :)");
        });
    })
    .catch((error) => {
      console.error(`?: Authorisation error ${error}`);

      res.status(401).send("Authorisation error");
      if (discordId !== null)
        discordClient.users.fetch(discordId).then((user) => {
          user.send(
            `Looks like there was an authorisation problem :( **Maybe try authorising again?** ${hostUrl}/authorise?discord=${discordId}`
          );
        });
    });
});

function generateRandomString(length: number) {
  var text = "";
  var possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < length; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}

app.get("/authorise", function (req, res) {
  var state = generateRandomString(16);

  res.cookie("discord_user_id", req.query.discord as string);

  res.redirect(
    "https://accounts.spotify.com/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        scope: scope,
        redirect_uri: redirectUri,
        state: state,
      }).toString()
  );
});

app.listen(port, function () {
  console.log(`App listening on port ${port}!`);
});

// Read files in the info directory
fs.readdir(`${volumeName}`, (err, files) => {
  if (err) {
    console.error("Error reading directory:", err);
    return;
  }

  // Iterate over each file
  files.forEach((file) => {
    const filePath = `${volumeName}/${file}`;

    // Read the content of each file
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        return;
      }

      const parsed = JSON.parse(data);
      if (!parsed) {
        console.error("Error parsing file:", data);
        return;
      }

      // Extract discordId from file content
      const discordId: string | null = parsed.discord;

      const accessToken = parsed.access;
      const refreshToken = parsed.refresh;
      const playlistId = parsed.playlist;
      const id = file.split(".")[0];

      scrobble(id, playlistId, discordId, accessToken, refreshToken, null);
    });
  });
});
