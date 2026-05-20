"""
Git-based update operations for MixPi
Handles fetching updates, version management, and safe repository operations.
"""

import logging
import os
import subprocess
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from packaging import version

logger = logging.getLogger(__name__)

# Default installation directory on Pi
INSTALL_DIR = Path("/opt/mixpi")


class GitUpdateError(Exception):
    """Exception raised for git update operations."""
    pass


def _run_git_command(args: List[str], cwd: Optional[Path] = None, timeout: int = 30) -> subprocess.CompletedProcess:
    """
    Run a git command with error handling and logging.
    
    Args:
        args: Git command arguments (e.g., ['fetch', 'origin'])
        cwd: Working directory (defaults to INSTALL_DIR)
        timeout: Command timeout in seconds
    
    Returns:
        Completed process result
        
    Raises:
        GitUpdateError: If git command fails
    """
    if cwd is None:
        cwd = INSTALL_DIR
        
    cmd = ['git'] + args
    logger.info(f"Running git command: {' '.join(cmd)} (cwd: {cwd})")
    
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=True
        )
        logger.debug(f"Git command output: {result.stdout.strip()}")
        return result
    except subprocess.CalledProcessError as e:
        logger.error(f"Git command failed: {e.stderr.strip()}")
        raise GitUpdateError(f"Git command failed: {e.stderr.strip()}") from e
    except subprocess.TimeoutExpired as e:
        logger.error(f"Git command timed out after {timeout}s")
        raise GitUpdateError(f"Git command timed out after {timeout}s") from e


def validate_repo_state() -> Dict[str, any]:
    """
    Validate the repository state and return status information.
    
    Returns:
        Dict with repo status: valid, has_changes, current_branch, etc.
    """
    status = {
        'valid': False,
        'has_changes': False,
        'current_branch': None,
        'current_commit': None,
        'behind_remote': False,
        'history_diverged': False,
        'force_update_required': False,
        'error': None
    }
    
    try:
        # Check if .git directory exists
        git_dir = INSTALL_DIR / '.git'
        if not git_dir.exists():
            status['error'] = f"No .git directory found at {INSTALL_DIR}"
            return status
            
        # Get current branch
        try:
            result = _run_git_command(['branch', '--show-current'])
            status['current_branch'] = result.stdout.strip()
        except GitUpdateError:
            # Might be detached HEAD
            pass
            
        # Get current commit
        result = _run_git_command(['rev-parse', 'HEAD'])
        status['current_commit'] = result.stdout.strip()[:8]
        
        # Check for uncommitted changes
        result = _run_git_command(['status', '--porcelain'])
        status['has_changes'] = bool(result.stdout.strip())
        
        # Check if behind remote and detect history divergence (if on a branch)
        if status['current_branch']:
            try:
                # Check commits behind
                result = _run_git_command(['rev-list', '--count', f"HEAD..origin/{status['current_branch']}"])
                behind_count = int(result.stdout.strip())
                status['behind_remote'] = behind_count > 0
                
                # Check commits ahead (local commits not on remote)
                result = _run_git_command(['rev-list', '--count', f"origin/{status['current_branch']}..HEAD"])
                ahead_count = int(result.stdout.strip())
                
                # History has diverged if we're both ahead and behind
                status['history_diverged'] = behind_count > 0 and ahead_count > 0
                status['force_update_required'] = status['history_diverged']
                
            except (GitUpdateError, ValueError):
                # Remote branch might not exist
                pass
        
        status['valid'] = True
        
    except GitUpdateError as e:
        status['error'] = str(e)
    
    return status


def fetch_updates() -> Tuple[bool, str]:
    """
    Fetch latest updates from origin remote.
    
    Returns:
        Tuple of (success, message)
    """
    try:
        # --tags --force ensures moved/updated tags are refreshed locally.
        # Without --force, git skips tags that already exist locally even if
        # they have been moved on the remote (e.g. after a tag re-point).
        _run_git_command(['fetch', 'origin', '--tags', '--force'], timeout=12)
        logger.info("Successfully fetched updates from origin")
        return True, "Successfully fetched updates"
    except GitUpdateError as e:
        error_msg = str(e).lower()
        
        # Map common network/connectivity failures to a clean offline message
        if any(phrase in error_msg for phrase in [
            'network is unreachable', 'temporary failure in name resolution',
            'could not resolve hostname', 'connection timed out',
            'no route to host', 'connection refused', 'timed out'
        ]):
            logger.warning(f"Network connectivity issue during fetch: {e}")
            return False, "No internet connection"
        else:
            logger.error(f"Git fetch failed: {e}")
            return False, f"Fetch failed: {e}"


def list_available_versions(offline_mode: bool = False) -> Dict[str, any]:
    """
    List available versions (tags) from the repository.
    
    Args:
        offline_mode: If True, only list locally cached tags
    
    Returns:
        Dict with 'stable', 'prerelease' lists, and 'offline_mode' flag
    """
    stable_versions = []
    prerelease_versions = []
    
    try:
        # Get all tags matching semantic versioning pattern
        result = _run_git_command(['tag', '--list', 'v*.*.*', '--sort=-version:refname'])
        tags = result.stdout.strip().split('\n')
        
        # Parse and categorize versions
        version_pattern = re.compile(r'^v(\d+\.\d+\.\d+)(?:-(.+))?$')
        
        for tag in tags:
            if not tag:
                continue
                
            match = version_pattern.match(tag)
            if not match:
                continue
                
            version_str = match.group(1)
            prerelease_suffix = match.group(2)
            
            try:
                # Validate semantic version
                parsed_version = version.Version(version_str)
                
                if prerelease_suffix:
                    prerelease_versions.append(tag)
                else:
                    stable_versions.append(tag)
                    
            except version.InvalidVersion:
                logger.warning(f"Invalid semantic version tag: {tag}")
                continue
                
    except GitUpdateError as e:
        logger.error(f"Failed to list versions: {e}")
    
    return {
        'stable': stable_versions,
        'prerelease': prerelease_versions,
        'offline_mode': offline_mode,
        'warning': 'Working offline - may not show latest releases' if offline_mode else None
    }


def stable_tag_upgrade_available(stable_tags: List[str]) -> bool:
    """
    True if any stable tag points to a commit strictly after HEAD (upgrade exists).

    Tags remain listed for downgrade; this only drives the "updates available" badge.
    """
    if not stable_tags:
        return False
    try:
        head = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
    except GitUpdateError:
        return False
    for tag in stable_tags:
        try:
            result = _run_git_command(
                ['rev-list', '--count', f'{head}..refs/tags/{tag}']
            )
            if int(result.stdout.strip()) > 0:
                return True
        except (GitUpdateError, ValueError):
            continue
    return False


def get_current_version() -> Dict[str, Optional[str]]:
    """
    Get current version information.
    
    Returns:
        Dict with current tag, commit hash, and branch info
    """
    current = {
        'tag': None,
        'commit': None,
        'branch': None,
        'describe': None
    }
    
    try:
        # Get current commit
        result = _run_git_command(['rev-parse', 'HEAD'])
        current['commit'] = result.stdout.strip()[:8]
        
        # Get current branch (if any)
        try:
            result = _run_git_command(['branch', '--show-current'])
            current['branch'] = result.stdout.strip()
        except GitUpdateError:
            pass
            
        # Get git describe (closest tag)
        try:
            result = _run_git_command(['describe', '--tags', '--always'])
            current['describe'] = result.stdout.strip()
            
            # Extract tag if on exact tag
            if '-' not in current['describe'] and current['describe'].startswith('v'):
                current['tag'] = current['describe']
                
        except GitUpdateError:
            pass
    
    except GitUpdateError as e:
        logger.error(f"Failed to get current version: {e}")
    
    return current


def get_main_branch_status(offline_mode: bool = False) -> Dict[str, any]:
    """
    Get status of main branch compared to current state.
    
    Args:
        offline_mode: If True, don't try to access origin/main
    
    Returns:
        Dict with commits ahead/behind info and latest commit
    """
    status = {
        'available': False,
        'commits_ahead': 0,
        'commits_behind': 0,
        'latest_commit': None,
        'latest_date': None,
        'offline_mode': offline_mode
    }
    
    if offline_mode:
        status['warning'] = 'Cannot check main branch status - no internet connection'
        return status
    
    try:
        # Get latest commit on origin/main
        result = _run_git_command(['rev-parse', 'origin/main'])
        status['latest_commit'] = result.stdout.strip()[:8]
        
        # Get commit date
        result = _run_git_command(['show', '-s', '--format=%ci', 'origin/main'])
        status['latest_date'] = result.stdout.strip()
        
        # Compare with current HEAD
        current_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        
        if current_commit != status['latest_commit']:
            # Count commits ahead/behind
            try:
                result = _run_git_command(['rev-list', '--count', f"HEAD..origin/main"])
                status['commits_ahead'] = int(result.stdout.strip())
                
                result = _run_git_command(['rev-list', '--count', f"origin/main..HEAD"])
                status['commits_behind'] = int(result.stdout.strip())
                
                status['available'] = status['commits_ahead'] > 0
            except (GitUpdateError, ValueError):
                pass
        
    except GitUpdateError as e:
        logger.error(f"Failed to get main branch status: {e}")
        # If we can't access origin/main, we're probably offline
        status['offline_mode'] = True
        status['warning'] = 'Cannot check main branch status - may be offline'
    
    return status


def checkout_version(target: str, force: bool = False) -> Tuple[bool, str]:
    """
    Checkout a specific version (tag or branch) with automatic rollback on failure.
    
    Args:
        target: Version to checkout (e.g., 'v1.0.0' or 'main')
        force: If True, allows potentially unsafe history rewrites
        
    Returns:
        Tuple of (success, message)
    """
    # Store current state for rollback
    rollback_state = None
    
    try:
        # Store current commit for rollback
        current_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        current_branch = None
        
        # Check if we're on a branch (for better rollback)
        try:
            result = _run_git_command(['branch', '--show-current'])
            current_branch = result.stdout.strip()
        except GitUpdateError:
            pass  # Detached HEAD is fine
            
        rollback_state = {
            'commit': current_commit,
            'branch': current_branch,
            'was_detached': current_branch == ''
        }
        
        # Validate target exists
        if target == 'main':
            # Check if origin/main exists locally (fetched previously)
            try:
                _run_git_command(['rev-parse', 'origin/main'])
                checkout_ref = 'origin/main'
            except GitUpdateError:
                return False, "Cannot update to main branch - no cached remote data. Please check internet connection."
        elif target.startswith('v'):
            # Verify tag exists locally
            try:
                _run_git_command(['rev-parse', f"refs/tags/{target}"])
                checkout_ref = target
            except GitUpdateError:
                return False, f"Tag {target} not found locally - may need internet connection to fetch latest tags"
        else:
            return False, f"Invalid target: {target}"
        
        # Check history safety unless force is specified
        if not force:
            safety = check_history_safety(target)
            if not safety['safe']:
                if safety['requires_force']:
                    return False, f"Update requires force flag due to history divergence: {safety['warning']}"
                else:
                    return False, safety['warning']
        
        # Perform checkout (with force if needed)
        logger.info(f"Attempting checkout from {current_commit[:8]} to {target}")
        
        if target == 'main':
            # Use checkout -B so HEAD stays on the local 'main' branch rather than
            # detaching.  'git checkout origin/main' would leave a detached HEAD,
            # causing git branch --show-current to return '' and breaking the
            # version display in the UI.
            _run_git_command(['checkout', '-B', 'main', checkout_ref])
        else:
            _run_git_command(['checkout', checkout_ref])
        
        # Verify checkout succeeded
        new_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        
        if target == 'main':
            message = f"Successfully updated to main branch (commit {new_commit[:8]})"
        else:
            message = f"Successfully updated to {target} (commit {new_commit[:8]})"
            
        logger.info(f"{message} (previous: {current_commit[:8]})")
        return True, message
        
    except GitUpdateError as e:
        error_msg = f"Failed to checkout {target}: {e}"
        logger.error(error_msg)
        
        # Attempt automatic rollback
        if rollback_state:
            rollback_success = _perform_rollback(rollback_state)
            if rollback_success:
                error_msg += f" - Automatically rolled back to {rollback_state['commit'][:8]}"
            else:
                error_msg += f" - WARNING: Rollback also failed! Manual recovery may be needed."
        
        return False, error_msg


def check_history_safety(target: str) -> Dict[str, any]:
    """
    Check if updating to target would require rewriting history.
    
    Args:
        target: Version to check (e.g., 'v1.0.0' or 'main')
        
    Returns:
        Dict with safety analysis and recommendations
    """
    safety = {
        'safe': True,
        'requires_force': False,
        'history_rewritten': False,
        'warning': None,
        'recommendation': 'safe_update'
    }
    
    try:
        current_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        
        if target == 'main':
            try:
                target_commit = _run_git_command(['rev-parse', 'origin/main']).stdout.strip()
                ref_name = 'origin/main'
            except GitUpdateError:
                safety['safe'] = False
                safety['warning'] = 'Cannot verify main branch safety - remote not available'
                return safety
        elif target.startswith('v'):
            try:
                target_commit = _run_git_command(['rev-parse', f"refs/tags/{target}"]).stdout.strip()
                ref_name = f"refs/tags/{target}"
            except GitUpdateError:
                safety['safe'] = False
                safety['warning'] = f'Tag {target} not found locally'
                return safety
        else:
            safety['safe'] = False
            safety['warning'] = f'Invalid target: {target}'
            return safety
        
        # If we're already at the target, no update needed
        if current_commit == target_commit:
            safety['recommendation'] = 'no_update_needed'
            return safety
        
        # Check if target is reachable from current commit (fast-forward possible)
        try:
            merge_base = _run_git_command(['merge-base', current_commit, target_commit]).stdout.strip()
            
            if merge_base == current_commit:
                # Target is ahead of us - safe fast-forward
                safety['recommendation'] = 'fast_forward'
            elif merge_base == target_commit:
                # We're ahead of target - this would be a rollback
                safety['warning'] = f'Target {target} is behind current commit - this is a rollback'
                safety['recommendation'] = 'rollback'
            else:
                # Histories have diverged
                safety['safe'] = False
                safety['requires_force'] = True
                safety['history_rewritten'] = True
                safety['warning'] = f'History has diverged between current commit and {target}'
                safety['recommendation'] = 'force_required'
                
        except GitUpdateError:
            # merge-base failed - likely no common history
            safety['safe'] = False
            safety['requires_force'] = True
            safety['history_rewritten'] = True
            safety['warning'] = f'No common history with {target} - may require force update'
            safety['recommendation'] = 'force_required'
    
    except GitUpdateError as e:
        safety['safe'] = False
        safety['warning'] = f'Failed to analyze history safety: {e}'
        
    return safety


def _perform_rollback(rollback_state: Dict[str, any]) -> bool:
    """
    Perform automatic rollback to previous state.
    
    Args:
        rollback_state: State information from before the failed update
        
    Returns:
        True if rollback succeeded
    """
    try:
        commit = rollback_state['commit']
        branch = rollback_state['branch']
        was_detached = rollback_state['was_detached']
        
        logger.warning(f"Attempting rollback to {commit[:8]} (branch: {branch or 'detached'})")
        
        if was_detached or not branch:
            # We were in detached HEAD, just checkout the commit
            _run_git_command(['checkout', commit])
        else:
            # We were on a branch, try to restore it
            try:
                # First checkout the branch
                _run_git_command(['checkout', branch])
                
                # If that worked, reset to the previous commit
                _run_git_command(['reset', '--hard', commit])
            except GitUpdateError:
                # Branch checkout failed, fallback to detached HEAD
                _run_git_command(['checkout', commit])
        
        # Verify rollback
        current_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        if current_commit == commit:
            logger.info(f"Successfully rolled back to {commit[:8]}")
            return True
        else:
            logger.error(f"Rollback verification failed: expected {commit[:8]}, got {current_commit[:8]}")
            return False
            
    except GitUpdateError as e:
        logger.error(f"Rollback failed: {e}")
        return False


def perform_manual_rollback() -> Tuple[bool, str]:
    """
    Perform manual rollback to the previous commit (from reflog).
    
    Returns:
        Tuple of (success, message)
    """
    try:
        # Get previous commit from reflog
        rollback_info = get_rollback_info()
        
        if not rollback_info['available']:
            return False, "No rollback information available"
        
        previous_commit = rollback_info['previous_commit']
        logger.info(f"Manual rollback requested to {previous_commit}")
        
        # Perform the rollback
        _run_git_command(['checkout', previous_commit])
        
        # Verify rollback
        current_commit = _run_git_command(['rev-parse', 'HEAD']).stdout.strip()
        if current_commit.startswith(previous_commit):
            message = f"Successfully rolled back to {previous_commit} ({rollback_info['previous_describe']})"
            logger.info(message)
            return True, message
        else:
            return False, f"Rollback verification failed"
            
    except GitUpdateError as e:
        error_msg = f"Manual rollback failed: {e}"
        logger.error(error_msg)
        return False, error_msg


def reset_to_clean_state() -> bool:
    """
    Reset repository to clean state, discarding local changes.
    
    Returns:
        True if successful
    """
    try:
        # Reset any staged changes
        _run_git_command(['reset', '--hard', 'HEAD'])
        
        # Clean untracked files
        _run_git_command(['clean', '-fd'])
        
        logger.info("Repository reset to clean state")
        return True
        
    except GitUpdateError as e:
        logger.error(f"Failed to reset repository: {e}")
        return False


def get_rollback_info() -> Dict[str, Optional[str]]:
    """
    Get information for potential rollback operations.
    
    Returns:
        Dict with previous commit info from reflog
    """
    rollback_info = {
        'previous_commit': None,
        'previous_describe': None,
        'available': False
    }
    
    try:
        # Get previous commit from reflog
        result = _run_git_command(['reflog', '--format=%H', '-n', '2'])
        commits = result.stdout.strip().split('\n')
        
        if len(commits) >= 2:
            previous_commit = commits[1]
            rollback_info['previous_commit'] = previous_commit[:8]
            
            # Get describe for previous commit
            try:
                result = _run_git_command(['describe', '--tags', '--always', previous_commit])
                rollback_info['previous_describe'] = result.stdout.strip()
                rollback_info['available'] = True
            except GitUpdateError:
                pass
    
    except GitUpdateError as e:
        logger.error(f"Failed to get rollback info: {e}")
    
    return rollback_info