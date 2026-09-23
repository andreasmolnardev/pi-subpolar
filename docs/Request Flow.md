# Request flow
This file describes what happens when you send a message to Subpolar.

Optional voice input (refer to Voice.md for more)
    |
    V
 Trascription
    |
    V

Message + Prev. Context (System Prompt, Skills, Appended Tools) - Predefined agent to use
|                      |                                           |
V                      V                                           |
Session title gen    Routing chooses project and agent             |
                      |                                            |
                      V                                            V
                                  Agent (project/agent)
                                  - thinking
                                  - Tool calls -> Resolver
                                  - final message
                |           |                                     /|
                V           V                                      |
            Compaction    Orchestration: Subagent, Handoff     Follow-up messages

## Title Gen
Ask a model (no tools) something along the lines of please output only a brief title for this request
Use specified model for this configured via settings

## Routing
Model will be given a list of agents the project has like root agents and project-specific agents their ids would for example be like productivity or homelab/productivity. Agent will be asked to choose the most fitting output as json with {targetAgentId}
Use specified model for this configured via settings

## Agent
Documented in agent-runtime.md and Tools.md
