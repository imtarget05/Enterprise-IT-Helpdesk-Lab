"""Safe Automation Gateway — package init."""
from .gateway import (
    ALLOWED,
    DENIED,
    INVALID,
    NEEDS_APPROVAL,
    AutomationGateway,
    GatewayDecision,
)
from .models import PROPOSAL_SCHEMA_VERSION, SUPPORTED_ACTIONS, validate_proposal
from .policy import (
    FORBIDDEN,
    HIGH_RISK,
    LOW_RISK,
    READ_ONLY,
    action_risk,
    authorize,
    is_forbidden_input,
)

__all__ = [
    "ALLOWED",
    "DENIED",
    "INVALID",
    "NEEDS_APPROVAL",
    "AutomationGateway",
    "GatewayDecision",
    "PROPOSAL_SCHEMA_VERSION",
    "SUPPORTED_ACTIONS",
    "validate_proposal",
    "FORBIDDEN",
    "HIGH_RISK",
    "LOW_RISK",
    "READ_ONLY",
    "action_risk",
    "authorize",
    "is_forbidden_input",
]
