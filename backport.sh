git reset HEAD~1
rm ./backport.sh
git cherry-pick 2dd017d522c8c2f358f26ed1aefab63699e6c6c4
echo 'Resolve conflicts and force push this branch.\n\nTo backport translations run: bin/i18n/merge-translations <release-branch>'
