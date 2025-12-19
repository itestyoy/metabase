git reset HEAD~1
rm ./backport.sh
git cherry-pick 0df342cd45d9ddaedaa1f87213bfb86977868489
echo 'Resolve conflicts and force push this branch.\n\nTo backport translations run: bin/i18n/merge-translations <release-branch>'
