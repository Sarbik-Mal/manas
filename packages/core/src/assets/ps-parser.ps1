# Manas PowerShell parser: one JSON request per line in ({id, command}),
# one JSON result per line out. Runs for the whole session, so each parse
# skips PowerShell's startup cost.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$L = [System.Management.Automation.Language.Ast].Namespace

# What a command name really is: aliases followed (dir -> Get-ChildItem), plus
# its module, so only built-in Microsoft cmdlets count as read-only. Cached.
$known = @{}
function Resolve-Name($name) {
	if ($null -eq $name -or $name -match '[*?\[]') { return @{ resolved = $name; module = $null; type = 'NotFound' } }
	$key = $name.ToLowerInvariant()
	if (-not $known.ContainsKey($key)) {
		$info = @{ resolved = $name; module = $null; type = 'NotFound' }
		$c = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($c) {
			$info.type = "$($c.CommandType)"
			# Follow an alias by its target's name; its module may not be loaded yet.
			if ($c.CommandType -eq 'Alias') {
				$t = Get-Command -Name $c.Definition -ErrorAction SilentlyContinue | Select-Object -First 1
				if ($t) { $c = $t }
			}
			# Only cmdlets and functions get their canonical name; npm stays npm.
			if ("$($c.CommandType)" -in 'Cmdlet', 'Function') { $info.resolved = $c.Name }
			$info.module = $c.ModuleName
		}
		$known[$key] = $info
	}
	$known[$key]
}

# A plain argument: text or a number, a parameter with a plain value, a list
# of constants, or a script block (its commands are checked on their own).
# Variables ($true, $false and $null aside) and expressions aren't.
$constant = 'StringConstantExpressionAst', 'ConstantExpressionAst'
function Test-Plain($e) {
	switch ($e.GetType().Name) {
		{ $_ -in $constant } { return $true }
		'ScriptBlockExpressionAst' { return $true }
		'CommandParameterAst' { return ($null -eq $e.Argument) -or (Test-Plain $e.Argument) }
		'ArrayLiteralAst' { return @($e.Elements | Where-Object { $_.GetType().Name -notin $constant }).Count -eq 0 }
		'VariableExpressionAst' { return $e.VariablePath.UserPath -in 'true', 'false', 'null' }
	}
	$false
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
	$id = $null
	try {
		$req = ConvertFrom-Json $line
		$id = $req.id
		$tokens = $null
		$errs = $null
		$ast = [System.Management.Automation.Language.Parser]::ParseInput($req.command, [ref]$tokens, [ref]$errs)
		$find = { param($type) $ast.FindAll({ param($n) $n.GetType().FullName -eq "$L.$type" }.GetNewClosure(), $true) }

		# Every command anywhere: pipelines, chains, $(...), script blocks.
		$commands = @(foreach ($c in (& $find 'CommandAst')) {
			$name = $c.GetCommandName()  # null when dynamic, e.g. & $tool
			$r = Resolve-Name $name
			$rest = @($c.CommandElements | Select-Object -Skip 1)
			@{
				name = $name
				resolved = $r.resolved
				module = $r.module
				type = $r.type
				args = @($rest | ForEach-Object { $_.Extent.Text })
				# Short AST names, e.g. StringConstant, ScriptBlock.
				kinds = @($rest | ForEach-Object { $_.GetType().Name -replace '(Expression)?Ast$', '' })
				plain = @($rest | Where-Object { -not (Test-Plain $_) }).Count -eq 0
			}
		})
		# Variables written through a drive or a scope: ${C:\x}, $env:X, $global:x.
		$scoped = { param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] -and ($n.VariablePath.IsDriveQualified -or $n.VariablePath.IsGlobal -or $n.VariablePath.IsScript) }
		$result = @{
			id = $id
			errors = @($errs | ForEach-Object { $_.Message })
			commands = $commands
			# File redirections anywhere, also on plain expressions ("x" > file).
			redirections = @(& $find 'FileRedirectionAst' | ForEach-Object { $_.Location.Extent.Text })
			# .NET calls like [IO.File]::Delete('x'): not commands, but can change things.
			invocations = @(& $find 'InvokeMemberExpressionAst' | ForEach-Object { $_.Extent.Text })
			# What Claude Code's PowerShell checks look at.
			subexpressions = @(& $find 'SubExpressionAst').Count -gt 0
			expandable = @(& $find 'ExpandableStringExpressionAst').Count -gt 0
			splatting = @(& $find 'VariableExpressionAst' | Where-Object { $_.Splatted }).Count -gt 0
			stopParsing = @($tokens | Where-Object { $_.Text -eq '--%' }).Count -gt 0
			types = @(@(& $find 'TypeExpressionAst') + @(& $find 'TypeConstraintAst') + @(& $find 'AttributeAst') | ForEach-Object { $_.TypeName.FullName })
			scopedAssignments = @(& $find 'AssignmentStatementAst' | Where-Object { $_.Left.FindAll($scoped, $true).Count -gt 0 } | ForEach-Object { $_.Left.Extent.Text })
			usings = $ast.UsingStatements.Count -gt 0
			requires = $null -ne $ast.ScriptRequirements
			background = @(& $find 'PipelineAst' | Where-Object { $_.Background }).Count -gt 0
		}
	} catch {
		$result = @{ id = $id; fatal = $_.Exception.Message }
	}
	[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 5))
	[Console]::Out.Flush()
}
