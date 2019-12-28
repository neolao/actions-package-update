import Octokit from "@octokit/rest";
import rmd from "@pnpm/read-modules-dir";
import execa, { Options as ExecaOptions } from "execa";
import giturl from "git-url-parse";
import moment from "moment";
import path from "path";
import hash from "sha.js";
import packageJson from "../package.json";
import { toMarkdown, toTextTable } from "./body";
import { Config } from "./config";
import Git from "./git";
import { readFile, readJson } from "./promisify";

export default class Processor {
  private readonly config: Config;
  private readonly git: Git;
  constructor(config: Config) {
    this.config = config;
    this.git = new Git(config);
  }

  public async run(): Promise<string> {
    const now = moment().format("YYYYMMDDhhmm");
    this.config.logger.info("Start process.");

    const { found, newBranch } = await this.makeBranch(now);
    if (found) {
      return `Found existing branch ${found}`;
    }

    const { oldone, newone } = await this.upgrade();

    const matrix = await this.commit();
    await this.git.checkout("-");
    const project = await readJson(
      path.join(this.config.get("workspace"), "package.json")
    );

    if (0 < matrix.length) {
      if (this.config.get("execute")) {
        await this.pullRequest(newBranch, project, oldone, newone, now);
      } else {
        this.config.logger.info(
          "git push is skipped. Because EXECUTE environment variable is not true"
        );
        this.config.logger.info(`\n${toTextTable(project, oldone, newone)}`);
      }
    } else {
      this.config.logger.info("Did not find outdated dependencies.");
    }

    if (!this.config.get("keep")) {
      this.config.logger.info(
        "Delete working branch because KEEP environment variable is not true"
      );
      await this.git.deleteBranch(newBranch);
    }

    return "All done!!";
  }

  protected async makeBranch(now: string) {
    this.config.logger.debug("START makeBranch");
    const json = await this.getFile("package.json");
    if (!json) {
      throw new Error("package.json not found");
    }

    const hex = new hash.sha1().update(json, "utf8").digest("hex");
    const newBranch = `${this.config.get("git").prefix}${now}/${hex}`;

    await this.git.fetch("origin");
    this.config.logger.debug("listBranches");
    const branches = await this.git.listBranches();
    this.config.logger.trace("%o", branches);
    const found = branches.find((name: string) => name.endsWith(hex));
    this.config.logger.debug("found branch is %s", found);
    if (!found) {
      await this.git.checkoutWith(newBranch);
    }
    this.config.logger.debug("END   makeBranch");
    return { found, newBranch };
  }

  protected async upgrade() {
    this.config.logger.debug("START upgrade");
    await this.install();
    const oldone = await this.collectPackage();
    const arg = process.argv.slice(2);
    const cmd = this.config.get("update");
    const ncu = await this.runInWorkspace(cmd, arg);
    if (ncu.failed) {
      this.config.logger.debug("FAILED upgrade");
      throw new Error(ncu.stderr);
    }
    await this.install();
    const newone = await this.collectPackage();
    this.config.logger.debug("END   upgrade");
    return { oldone, newone };
  }

  protected async commit() {
    this.config.logger.debug("START commit");
    const matrix = await this.git.status();
    if (0 < matrix.length) {
      this.config.logger.debug("files are changed");
      this.config.logger.trace("changed files are %o", matrix);
      await this.git.addAll();
      await this.git.setup(
        this.config.get("git").username,
        this.config.get("git").useremail
      );
      await this.git.commit(this.config.get("git").message);
    }
    this.config.logger.debug("END   commit");
    return matrix;
  }

  protected async newGitHub(config: Config, repo: giturl.GitUrl) {
    const ghopt: Octokit.Options = {
      auth: `token ${config.get("token")}`,
      userAgent: `${packageJson.name}/${packageJson.version}`
    };
    if (repo.resource !== "github.com") {
      // for GHE
      ghopt.baseUrl = `https://${repo.resource}/api/v3`;
    }
    return new Octokit(ghopt);
  }

  protected async pullRequest(
    newBranch: string,
    project: PackageJson,
    oldone: Map<string, PackageJson>,
    newone: Map<string, PackageJson>,
    now: string
  ) {
    this.config.logger.debug("START pullRequest");

    await this.git.push("origin", newBranch);
    const body = toMarkdown(project, oldone, newone);
    const url = await this.git.remoteurl("origin");
    const origin = giturl(url);
    const github = await this.newGitHub(this.config, origin);
    const repo = await github.repos.get({
      owner: origin.owner,
      repo: origin.name
    });
    const pr: Octokit.PullsCreateParams = {
      owner: origin.owner,
      repo: origin.name,
      base: repo.data.default_branch,
      head: newBranch,
      title: `update dependencies at ${now}`,
      body
    };
    this.config.logger.debug("Pull Request create");
    this.config.logger.trace(pr);
    const createdPullRequest: Octokit.Response<Octokit.PullsCreateResponse> = await github.pulls.create(pr);
    const addLabelsParams: Octokit.IssuesAddLabelsParams = {
      owner: origin.owner,
      repo: origin.name,
      issue_number: createdPullRequest.data.number,
      labels: ["depenencies"]
    };
    await github.issues.addLabels(addLabelsParams);
    this.config.logger.debug("END   pullRequest");
  }

  protected async install() {
    this.config.logger.debug("START install");
    const yl = await this.getFile("yarn.lock");
    if (yl) {
      this.config.logger.debug("use yarn");
      await this.runInWorkspace("yarn", "install");
      return;
    }

    this.config.logger.debug("use npm");
    await this.runInWorkspace("npm", "install");

    this.config.logger.debug("END   install");
  }

  protected async getFile(name: string, encoding: string = "utf8") {
    const n = path.join(this.config.get("workspace"), name);
    this.config.logger.debug("getFile %s", n);
    return readFile(n, { encoding }).catch(() => undefined);
  }

  protected async runInWorkspace(
    command: string,
    args?: string[] | string,
    opts?: ExecaOptions
  ) {
    const a = typeof args === "string" ? [args] : args;
    this.config.logger.debug("runInWorkspace %s %o", command, a);
    const kids = execa(command, a, {
      cwd: this.config.get("workspace"),
      ...opts
    });
    if (this.config.logger.levelVal < 30) {
      if (kids.stdout) {
        kids.stdout.pipe(process.stdout);
      }
      if (kids.stderr) {
        kids.stderr.pipe(process.stderr);
      }
    }
    return kids;
  }

  protected async collectPackage(): Promise<Map<string, PackageJson>> {
    this.config.logger.debug("START collectPackage");
    const workspace = this.config.get("workspace");
    const shadows = this.config.get("shadows");
    const root = await readJson(`${workspace}/package.json`);
    this.config.logger.trace(root);
    const contains = (name: string, d?: Dependencies) => d && d[name];
    const filter = shadows
      ? () => true
      : ([name, _]: [string, PackageJson]) => {
          return (
            contains(name, root.dependencies) ||
            contains(name, root.devDependencies) ||
            contains(name, root.optionalDependencies)
          );
        };

    const modules = path.join(workspace, "node_modules");
    const dirs = await rmd(modules);
    this.config.logger.trace("module directories are %o", dirs);
    if (dirs) {
      const pkgs = await Promise.all(
        dirs.map((dir: string) => readJson(`${modules}/${dir}/package.json`))
      );
      this.config.logger.trace("packages %o", pkgs);
      const nvs = pkgs
        .map<[string, PackageJson]>((p: PackageJson) => [p.name, p])
        .filter(filter);
      this.config.logger.debug("END   collectPackage");
      return new Map(nvs);
    }
    this.config.logger.debug("END   collectPackage");
    return new Map();
  }
}
