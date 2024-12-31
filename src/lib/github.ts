import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { LRUCache } from "lru-cache";

// Cache configuration
const cache = new LRUCache({
  max: 100, // Maximum number of items
  ttl: 1000 * 60 * 5, // Time to live: 5 minutes
});

// Rate limiting configuration
const rateLimiter = {
  lastCall: 0,
  minInterval: 1000, // Minimum time between calls in milliseconds
};

async function rateLimit() {
  const now = Date.now();
  const timeSinceLastCall = now - rateLimiter.lastCall;
  if (timeSinceLastCall < rateLimiter.minInterval) {
    await new Promise((resolve) =>
      setTimeout(resolve, rateLimiter.minInterval - timeSinceLastCall)
    );
  }
  rateLimiter.lastCall = Date.now();
}

export interface RepoStats {
  name: string;
  commits: number;
  stars: number;
  url: string;
  description: string | null;
  language: string | null;
  contributions: number;
  isPrivate: boolean;
}

async function getAllRepositories(graphqlWithAuth: any, login: string) {
  const repositories = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const { user } = await graphqlWithAuth(
      `
      query getRepositories($cursor: String) {
        user(login: "${login}") {
          repositories(
            first: 100,
            after: $cursor,
            orderBy: {field: UPDATED_AT, direction: DESC},
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ) {
            nodes {
              nameWithOwner
              isPrivate
              url
              description
              primaryLanguage {
                name
              }
              stargazerCount
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(first: 0) {
                      totalCount
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
      { cursor }
    );

    repositories.push(...user.repositories.nodes);
    hasNextPage = user.repositories.pageInfo.hasNextPage;
    cursor = user.repositories.pageInfo.endCursor;
  }

  return repositories;
}

export async function getGitHubStats(accessToken: string | undefined | null) {
  if (!accessToken) {
    throw new Error("No access token provided");
  }

  // Check cache first
  const cacheKey = `stats-${accessToken}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const octokit = new Octokit({
    auth: accessToken,
  });

  try {
    await rateLimit(); // Apply rate limiting

    // Create a GraphQL client
    const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${accessToken}`,
      },
    });

    // Get user's contributions data using GraphQL
    const { user } = await graphqlWithAuth(`
      query {
        user(login: "${(await octokit.users.getAuthenticated()).data.login}") {
          contributionsCollection {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            commitContributionsByRepository(maxRepositories: 100) {
              repository {
                nameWithOwner
                isPrivate
                url
                description
                primaryLanguage {
                  name
                }
                stargazerCount
                owner {
                  login
                }
              }
              contributions {
                totalCount
              }
            }
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  contributionCount
                  date
                  weekday
                }
              }
            }
          }
          repositories(
            first: 100, 
            orderBy: {field: UPDATED_AT, direction: DESC}, 
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              nameWithOwner
              isPrivate
              url
              description
              primaryLanguage {
                name
              }
              stargazerCount
            }
          }
        }
      }
    `);

    // Process daily contributions from the contribution calendar
    const dailyContributions: Record<string, number> = {};
    const activeDaysSet = new Set<string>();

    user.contributionsCollection.contributionCalendar.weeks.forEach(
      (week: any) => {
        week.contributionDays.forEach((day: any) => {
          if (day.contributionCount > 0) {
            const date = new Date(day.date);
            const dayKey = date.toLocaleDateString("en-US", {
              weekday: "long",
            });
            dailyContributions[dayKey] =
              (dailyContributions[dayKey] || 0) + day.contributionCount;
            activeDaysSet.add(day.date);
          }
        });
      }
    );

    // Get total comments and reviews from the GraphQL data
    const totalComments = user.contributionsCollection.totalIssueContributions;
    const totalReviews =
      user.contributionsCollection.totalPullRequestReviewContributions;

    // Calculate total contributions including private repos
    const allRepoContributions =
      user.contributionsCollection.totalCommitContributions;

    // Replace the pagination attempt with a manual pagination implementation
    const login = (await octokit.users.getAuthenticated()).data.login;
    const allRepositories = await getAllRepositories(graphqlWithAuth, login);

    // Then update the repoStats transformation
    const repoStats: RepoStats[] = allRepositories.map((repo: any) => ({
      name: repo.nameWithOwner,
      commits: repo.defaultBranchRef?.target?.history?.totalCount || 0,
      stars: repo.stargazerCount,
      url: repo.url,
      description: repo.description,
      language: repo.primaryLanguage?.name || null,
      contributions: repo.defaultBranchRef?.target?.history?.totalCount || 0,
      isPrivate: repo.isPrivate,
    }));

    // Aggregate languages
    const languageStats: Record<string, number> = {};
    repoStats.forEach((repo) => {
      if (repo.language) {
        languageStats[repo.language] =
          (languageStats[repo.language] || 0) + repo.commits;
      }
    });

    const totalLanguageCommits = Object.values(languageStats).reduce(
      (sum, count) => sum + count,
      0
    );
    const languages = Object.entries(languageStats)
      .map(([name, count]) => ({
        name,
        percentage: (count / totalLanguageCommits) * 100,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    // Convert daily contributions to sorted array
    const daysOrder = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    const contributionsByDay = daysOrder.map((day) => ({
      day,
      count: dailyContributions[day] || 0,
    }));

    const result = {
      repos: repoStats.sort((a, b) => b.commits - a.commits),
      totalCommits: allRepoContributions, // Use total from all repos
      totalComments,
      totalReviews,
      totalRepos: repoStats.length, // This remains public repos only
      activeDays: activeDaysSet.size,
      contributionsByDay,
      contributionsByType: [
        { type: "Commits", count: allRepoContributions }, // Use total from all repos
        { type: "Comments", count: totalComments },
        { type: "Reviews", count: totalReviews },
      ],
      languages,
      user: {
        login: (await octokit.users.getAuthenticated()).data.login,
        avatarUrl: (await octokit.users.getAuthenticated()).data.avatar_url,
      },
    };

    // Cache the result
    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Error fetching GitHub stats:", error);
    throw error;
  }
}
