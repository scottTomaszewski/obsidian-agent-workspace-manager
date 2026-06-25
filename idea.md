---
tags: 
---

# Obsidian Agent Workspace Manager

## Vision

Agent Workspace Manager is an Obsidian-based control plane for agentic software development.

Unlike traditional IDEs or terminal multiplexers, it is task-centric rather than editor-centric. The primary objects are Tasks, Workspaces, and Agents. Development activities are orchestrated around markdown notes, while existing tools (Claude Code, Codex, Gemini CLI, Git, Zellij, tmux, SSH, etc.) perform the actual work.

The goal is not to replace existing developer tools. Instead, it provides a unified interface for planning, launching, monitoring, reviewing, and coordinating AI agents across one or more development environments.

## Core Principles

### Markdown First

Markdown files are the source of truth.

Tasks, workspace configuration, agent status, progress, and documentation are stored as markdown with frontmatter rather than in a proprietary database.

Benefits:

* Human readable
* Git friendly
* Searchable
* Backlinkable
* Compatible with existing Obsidian workflows
* Extensible through community plugins

### Task-Centric

The system revolves around tasks, not terminals.

A task can exist without an active agent.

Agents are temporary workers assigned to complete tasks.

Tasks remain valuable after completion because they become permanent project documentation.

### Bring Your Own Tools

The system should integrate with existing tools instead of replacing them.

Examples:

* Claude Code
* Codex CLI
* Gemini CLI
* Local LLMs
* Git
* Git Worktrees
* SSH
* Docker
* Dev Containers
* Zellij
* tmux
* Embedded Obsidian terminal
* External terminals

Users should be able to choose whichever tools best fit their workflow.

## High Level Architecture

```text
                 Obsidian Plugin
                        │
             Local RPC / Socket API
                        │
           Agent Orchestrator Daemon
                        │
      ┌──────────┬──────────┬──────────┐
      │          │          │          │
     Git      Agent CLI    Workspace   Mux Backend
                            Backend
```

The orchestrator is responsible for automation.

Obsidian provides the user interface.

Execution is delegated to external tools.

## Workspace

A Workspace represents an isolated development environment.

A workspace contains:

* repositories
* tasks
* execution profile
* active agents
* environment variables
* terminal backend
* conversations
* configuration

Example:

```text
Workspace
├── Repositories
├── Tasks
├── Agents
├── Execution Profile
├── Environment
└── Terminal Backend
```

A workspace should persist even when no agents are running.

## Execution Profiles

Execution Profiles describe *how* work is executed.

They encapsulate credentials and environment rather than AI models.

Example:

```yaml
profile: work

git:
  user: Company User

provider:
  type: claude
  account: company

terminal:
  backend: zellij

host:
  type: local
```

Another profile:

```yaml
profile: personal

git:
  user: Personal User

provider:
  type: claude
  account: personal

host:
  type: ssh
  address: mini-pc
```

Changing profiles should automatically switch:

* AI account
* Git identity
* SSH keys
* Environment variables
* Host
* Terminal backend

without requiring task changes.

## Repositories

A workspace may contain one or more repositories.

Examples:

Single repository:

```text
Workspace
└── Repository
```

Multiple repositories:

```text
Workspace
├── Compendium
├── MkDocs Theme
└── Documentation
```

Tasks declare which repositories they require.

Example:

```yaml
repositories:
  - compendium
  - mkdocs-theme
```

The orchestrator creates a unified workspace for the assigned agent.

## Tasks

Tasks are markdown notes.

Example:

```yaml
---
status: Running

workspace: Draw Steel

repositories:
  - compendium

agent: Claude

priority: High

depends:
  - Update API

---
```

Each task contains:

* description
* acceptance criteria
* progress
* human notes
* agent notes
* conversations
* attachments
* links

Tasks become permanent project documentation.

## Agents

Agents are workers assigned to tasks.

An agent has:

* provider
* current task
* execution profile
* workspace
* conversation
* terminal session
* status

Agents are disposable.

Tasks are permanent.

## Desired State

Tasks define desired state.

Example:

```yaml
status: Running
```

The orchestrator reconciles actual state.

Possible states:

* Pending
* Running
* Waiting
* Needs Review
* Completed
* Paused
* Failed
* Cancelled

Changing markdown changes desired state.

The orchestrator performs the necessary actions.

## Multiplexer Abstraction

The orchestrator should not depend on a specific terminal multiplexer.

Instead it defines a backend interface.

```text
Multiplexer

Create Workspace

Destroy Workspace

Execute Command

Focus Workspace

List Sessions
```

Possible implementations:

* Zellij
* tmux
* WezTerm
* Embedded terminal
* External terminal
* Headless

This allows users to choose their preferred environment.

## Workspace Backends

Execution should also be backend-agnostic.

Examples:

Local filesystem

SSH

Docker

Dev Container

Remote VM

Cloud workspace

The orchestrator launches agents in the appropriate environment.

## Obsidian UI

Obsidian acts as the control center.

Each task should expose actions such as:

* Start Agent
* Pause Agent
* Resume Agent
* Stop Agent
* Open Terminal
* Open Conversation
* View Diff
* Review Changes
* Open Workspace
* Merge Branch

## Embedded Terminal

If available, an embedded terminal may be used.

The terminal is simply another view of the workspace.

It should not be the primary interface.

## File Editing

The plugin should support lightweight editing.

Goals:

* tweak CSS
* edit markdown
* modify YAML
* rename variables
* resolve merge conflicts

Heavy development should remain in external editors.

## Review Workflow

The primary editing experience is review.

Agent completes work.

User sees:

Modified Files

Selecting a file shows:

* diff
* syntax highlighting
* inline comments

Actions:

* Accept
* Reject
* Edit
* Ask Agent

This encourages review rather than blindly accepting AI changes.

## Conversations

Each task stores its conversation history.

Conversation belongs to the task rather than the terminal.

This allows:

* restarting agents
* switching providers
* historical review
* documentation

## Multi Project Support

A single vault may contain multiple workspaces.

Example:

```text
Vault

Projects

    Work

    Draw Steel

    Obsidian Plugin

    Homelab
```

Each workspace is isolated.

Tasks cannot accidentally use the wrong execution profile.

## Remote Development

Remote development should be transparent.

Possible execution targets:

* Local machine
* SSH
* Docker
* Dev Container
* Remote VM

The task should not need to know where execution occurs.

Only the execution profile determines this.

## Future Features

Possible future capabilities include:

* Agent handoffs
* Automatic dependency resolution
* Agent-to-agent messaging
* Review queues
* Merge automation
* GitHub/GitLab integration
* Pull request generation
* CI monitoring
* Knowledge indexing
* Semantic search
* Long-term project memory
* Multiple simultaneous providers
* Workspace snapshots
* Shared workspaces
* Collaborative review

## Non Goals

The project should not attempt to become:

* a replacement for VS Code
* a replacement for Zed
* a replacement for Neovim
* a replacement for Git
* a replacement for terminal multiplexers
* a replacement for AI providers

Instead, it should orchestrate these tools into a coherent, task-centric workflow.

## Guiding Philosophy

Everything should revolve around the workspace and its tasks.

Agents, terminals, repositories, and conversations are transient execution details.

Tasks are the permanent record of the work.

The orchestrator exists to reconcile the desired state expressed in markdown with the actual state of the development environment while remaining agnostic to editors, terminals, AI providers, and execution environments.

