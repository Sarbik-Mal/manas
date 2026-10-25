# Manas PowerShell parser: one JSON request per line in ({id, command}),
# one JSON result per line out. Runs for the whole session, so each parse
# skips PowerShell's startup cost.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$L = [System.Management.Automation.Language.Ast].Namespace

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
			@{
				name = $c.GetCommandName()  # null when dynamic, e.g. & $tool
				args = @($c.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
			}
		})
		$result = @{
			id = $id
			errors = @($errs | ForEach-Object { $_.Message })
			commands = $commands
			# File redirections anywhere, also on plain expressions ("x" > file).
			redirections = @(& $find 'FileRedirectionAst' | ForEach-Object { $_.Location.Extent.Text })
			# .NET calls like [IO.File]::Delete('x'): not commands, but can change things.
			invocations = @(& $find 'InvokeMemberExpressionAst' | ForEach-Object { $_.Extent.Text })
		}
	} catch {
		$result = @{ id = $id; fatal = $_.Exception.Message }
	}
	[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 5))
	[Console]::Out.Flush()
}
